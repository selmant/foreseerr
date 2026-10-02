import dataSource, { getRepository } from '@server/datasource';
import { MappingDataset } from '@server/entity/MappingDataset';
import { MappingEdge } from '@server/entity/MappingEdge';
import logger from '@server/logger';
import { promises as fsp } from 'fs';
import path from 'path';
import {
  DATASETS,
  datasetDefinition,
  extraMirrors,
  type DatasetDefinition,
} from './definitions';
import { PackFetchError, fetchPack, getPackDirectory } from './download';
import type { EdgeRow, ParsedDataset } from './parsers';
import {
  beginPackProgress,
  endPackProgress,
  reportDownloadBytes,
  updatePackProgress,
} from './progress';

/** Active generation per enabled dataset; what a lookup is allowed to read. */
const active = new Map<string, number>();
let activeLoaded = false;
/** An enabled dataset has never been written: first boot, or just enabled. */
let unwritten = false;
const listeners = new Set<() => void>();
/**
 * Bumped whenever a dataset is turned on or off. A refresh that started under
 * an older value was overtaken: disabling deleted some of what it wrote.
 */
const toggles = new Map<string, number>();

/** Called whenever the readable edge set changes, to drop lookup caches. */
export const onDatasetsChanged = (listener: () => void): void => {
  listeners.add(listener);
};

const notifyChanged = (): void => {
  for (const listener of listeners) listener();
};

let seeding: Promise<void> | undefined;

/** Every known dataset has a row; a new one starts enabled and unwritten. */
async function ensureRows(): Promise<MappingDataset[]> {
  const repository = getRepository(MappingDataset);
  seeding ??= (async () => {
    const existing = await repository.find();
    for (const definition of DATASETS) {
      if (existing.some((row) => row.key === definition.key)) continue;
      await repository.insert({
        key: definition.key,
        enabled: true,
        generation: 0,
      });
    }
  })().finally(() => {
    seeding = undefined;
  });
  await seeding;
  return repository.find();
}

export async function loadActiveGenerations(
  options: { force?: boolean } = {}
): Promise<void> {
  if (activeLoaded && !options.force) return;
  const rows = await ensureRows();
  active.clear();
  unwritten = false;
  for (const row of rows) {
    if (!row.enabled || !datasetDefinition(row.key)) continue;
    if (row.generation > 0) active.set(row.key, row.generation);
    else unwritten = true;
  }
  activeLoaded = true;
}

/** Whether an edge row belongs to the generation readers currently follow. */
export const isActiveEdge = (dataset: string, generation: number): boolean =>
  active.get(dataset) === generation;

export { DATASETS, datasetDefinition } from './definitions';

export const datasetRank = (key: string): number =>
  datasetDefinition(key)?.rank ?? Number.MAX_SAFE_INTEGER;

export const resetDatasetState = (): void => {
  active.clear();
  activeLoaded = false;
  unwritten = false;
  refreshes.clear();
  toggles.clear();
};

export interface DatasetRefreshResult {
  key: string;
  status: 'downloaded' | 'notModified' | 'lastGood' | 'skipped' | 'failed';
  edges?: number;
  error?: string;
}

const INSERT_CHUNK = 500;
// How long one ingest slice may hold the database before requests get a turn.
const INGEST_SLICE_MSEC = 50;
const MIN_DROP_COMPARE_COUNT = 1000;
const MAX_DROP_RATIO = 0.5;

// bun:sqlite answers synchronously, so an ingest that never yields keeps the
// event loop from serving a single request until the whole file is written.
const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

const deleteGeneration = (
  key: string,
  compare: '=' | '<>',
  generation: number
): Promise<unknown> =>
  getRepository(MappingEdge)
    .createQueryBuilder()
    .delete()
    .where(`dataset = :key AND generation ${compare} :generation`, {
      key,
      generation,
    })
    .execute();

/**
 * Write a parsed dataset under a new generation.
 *
 * Readers keep following the old generation until the pointer moves, so the
 * write can be sliced into short transactions without anyone seeing half of it.
 */
export async function writeGeneration(
  key: string,
  generation: number,
  edges: EdgeRow[],
  options: { sliceMsec?: number } = {}
): Promise<void> {
  const sliceMsec = options.sliceMsec ?? INGEST_SLICE_MSEC;
  // A previous run that died mid-write left rows under this number.
  await deleteGeneration(key, '=', generation);

  let next = 0;
  while (next < edges.length) {
    await yieldToEventLoop();
    await dataSource.transaction(async (manager) => {
      const started = Date.now();
      do {
        const chunk = edges.slice(next, next + INSERT_CHUNK);
        await manager
          .createQueryBuilder()
          .insert()
          .into(MappingEdge)
          .values(chunk.map((edge) => ({ ...edge, dataset: key, generation })))
          .execute();
        next += chunk.length;
      } while (next < edges.length && Date.now() - started < sliceMsec);
    });
    updatePackProgress(key, {
      phase: 'ingesting',
      recordsDone: next,
      recordsTotal: edges.length,
    });
  }
}

async function refreshUnlocked(
  definition: DatasetDefinition,
  options: { force?: boolean },
  /** The enable/disable count when this run was asked for. */
  toggle: number
): Promise<DatasetRefreshResult> {
  const { key } = definition;
  const repository = getRepository(MappingDataset);
  await ensureRows();
  const row = await repository.findOneByOrFail({ key });
  if (!row.enabled || (toggles.get(key) ?? 0) !== toggle) {
    return { key, status: 'skipped' };
  }

  beginPackProgress(key);
  try {
    let parsed: ParsedDataset | undefined;
    // Without a readable generation a 304 would leave nothing to serve.
    const conditional = !options.force && row.generation > 0;
    const fetched = await fetchPack({
      key,
      format: 'json',
      mirrors: [...definition.urls, ...extraMirrors(key)],
      cache: conditional
        ? {
            etag: row.etag ?? undefined,
            lastModified: row.lastModified ?? undefined,
          }
        : undefined,
      validate: (body) => {
        updatePackProgress(key, { phase: 'parsing' });
        const result = definition.parse(body);
        if (!result.edges.length) {
          throw new Error('dataset parsed to zero edges');
        }
        const previous = row.edgeCount ?? 0;
        if (
          previous >= MIN_DROP_COMPARE_COUNT &&
          result.edges.length < previous * MAX_DROP_RATIO
        ) {
          throw new Error(
            `dataset dropped from ${previous} to ${result.edges.length} edges`
          );
        }
        parsed = result;
      },
      onProgress: ({ received, total, mirror }) =>
        reportDownloadBytes(key, received, total, mirror),
    });

    const now = new Date();
    if (fetched.status === 'notModified' && row.generation > 0) {
      await repository.update(key, {
        lastFetchedAt: now,
        lastSuccessAt: now,
        lastError: null,
      });
      return { key, status: 'notModified', edges: row.edgeCount ?? undefined };
    }

    if (fetched.status === 'lastGood' && row.generation > 0) {
      // Every mirror failed and the copy on disk is already what is loaded.
      await repository.update(key, {
        lastFetchedAt: now,
        lastError: 'Upstream unreachable; keeping the loaded copy.',
      });
      return { key, status: 'lastGood', edges: row.edgeCount ?? undefined };
    }

    const result =
      parsed ?? (fetched.body ? definition.parse(fetched.body) : undefined);
    if (!result?.edges.length) throw new Error('dataset has no edges');

    const generation = row.generation + 1;
    await writeGeneration(key, generation, result.edges);
    if ((toggles.get(key) ?? 0) !== toggle) {
      await deleteGeneration(key, '=', generation);
      return { key, status: 'skipped' };
    }
    await repository.update(key, {
      generation,
      edgeCount: result.edges.length,
      version: result.version ?? fetched.sha256?.slice(0, 12) ?? null,
      etag: fetched.etag ?? null,
      lastModified: fetched.lastModified ?? null,
      lastFetchedAt: now,
      // Serving the copy on disk is not a successful refresh.
      ...(fetched.status === 'lastGood' ? {} : { lastSuccessAt: now }),
      lastError:
        fetched.status === 'lastGood'
          ? 'Upstream unreachable; serving the last downloaded copy.'
          : null,
    });
    await loadActiveGenerations({ force: true });
    notifyChanged();
    await deleteGeneration(key, '<>', generation);

    logger.info(`Refreshed mapping dataset ${key}`, {
      label: 'Mapping',
      status: fetched.status,
      edges: result.edges.length,
      mirror: fetched.mirror,
    });
    return { key, status: fetched.status, edges: result.edges.length };
  } catch (error) {
    const message =
      error instanceof PackFetchError
        ? `${error.message}: ${error.attempts.map((a) => `${a.mirror} (${a.error})`).join('; ')}`
        : error instanceof Error
          ? error.message
          : String(error);
    await repository.update(key, {
      lastFetchedAt: new Date(),
      lastError: message,
    });
    logger.error(`Unable to refresh mapping dataset ${key}`, {
      label: 'Mapping',
      errorMessage: message,
    });
    return { key, status: 'failed', error: message };
  } finally {
    endPackProgress(key);
  }
}

const refreshes = new Map<
  string,
  { work: Promise<DatasetRefreshResult>; toggle: number }
>();

/** Download, validate and swap in one dataset. Concurrent calls share a run. */
export function refreshDataset(
  key: string,
  options: {
    force?: boolean;
    /** Test seam: the same dataset served from somewhere else. */
    urls?: string[];
  } = {}
): Promise<DatasetRefreshResult> {
  const known = datasetDefinition(key);
  const definition =
    known && options.urls ? { ...known, urls: options.urls } : known;
  if (!definition) {
    return Promise.resolve({
      key,
      status: 'failed',
      error: 'Unknown mapping dataset.',
    });
  }
  const running = refreshes.get(key);
  const toggle = toggles.get(key) ?? 0;
  if (running?.toggle === toggle) return running.work;
  // A run started before the last enable or disable will throw its work away,
  // so a fresh one follows it.
  const work = (running?.work ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => refreshUnlocked(definition, options, toggle))
    .finally(() => {
      if (refreshes.get(key)?.work === work) refreshes.delete(key);
    });
  refreshes.set(key, { work, toggle });
  return work;
}

/** Files left on disk by packs that are no longer used. */
const RETIRED_FILES = ['animeapi.json', 'anime-lists.xml'];

async function removeRetiredFiles(): Promise<void> {
  for (const name of RETIRED_FILES) {
    for (const file of [name, `${name}.last-good`]) {
      await fsp.rm(path.join(getPackDirectory(), file), { force: true });
    }
  }
}

/** Never rejects: a dead upstream leaves the current generation in place. */
export async function refreshAllDatasets(
  options: { force?: boolean } = {}
): Promise<DatasetRefreshResult[]> {
  await removeRetiredFiles().catch(() => undefined);
  const results: DatasetRefreshResult[] = [];
  for (const definition of [...DATASETS].sort((a, b) => a.rank - b.rank)) {
    results.push(await refreshDataset(definition.key, options));
  }
  return results;
}

/**
 * Turn a dataset on or off. Disabling only hides its edges from readers; they
 * are deleted so a later enable starts from a clean download.
 */
export async function setDatasetEnabled(
  key: string,
  enabled: boolean
): Promise<MappingDataset | undefined> {
  if (!datasetDefinition(key)) return undefined;
  await ensureRows();
  toggles.set(key, (toggles.get(key) ?? 0) + 1);
  const repository = getRepository(MappingDataset);
  await repository.update(
    key,
    enabled
      ? { enabled }
      : {
          enabled,
          generation: 0,
          edgeCount: null,
          etag: null,
          lastModified: null,
        }
  );
  await loadActiveGenerations({ force: true });
  notifyChanged();
  if (!enabled) await deleteGeneration(key, '<>', 0);
  return (await repository.findOneBy({ key })) ?? undefined;
}

export async function listDatasets(): Promise<
  (MappingDataset & Pick<DatasetDefinition, 'licence' | 'note' | 'rank'>)[]
> {
  const rows = await ensureRows();
  return DATASETS.flatMap((definition) => {
    const row = rows.find((candidate) => candidate.key === definition.key);
    return row
      ? [
          {
            ...row,
            licence: definition.licence,
            note: definition.note,
            rank: definition.rank,
          },
        ]
      : [];
  });
}

let initialLoad: Promise<unknown> | undefined;
let initialLoading = false;

/**
 * Whether the datasets are being downloaded for the first time. Lookups made
 * meanwhile would guess at titles the datasets are about to answer.
 */
export const datasetsLoading = (): boolean => initialLoading;

/**
 * Make the datasets readable for one lookup, without blocking on a download.
 *
 * A dataset that has never been written (first boot, or just enabled) is
 * fetched in the background; lookups meanwhile fall through to the later
 * resolution steps.
 */
export async function ensureMappingLayer(): Promise<void> {
  await loadActiveGenerations();
  // Tests exercise lookups against seeded edges; downloading datasets behind
  // their backs would make them slow and network-dependent.
  if (!unwritten || initialLoad || process.env.NODE_ENV === 'test') return;
  initialLoading = true;
  initialLoad = refreshAllDatasets().finally(() => {
    initialLoading = false;
    // A failed first download is retried by the nightly job, not per request.
    setTimeout(() => (initialLoad = undefined), 3600 * 1000).unref?.();
  });
}
