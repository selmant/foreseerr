import dataSource, { getRepository } from '@server/datasource';
import { MappingSource } from '@server/entity/MappingSource';
import { upsertEpisodeRule } from '@server/lib/mapping/episodes';
import {
  beginPackGraphRewrite,
  endPackGraphRewrite,
  mappingSourceContributes,
  retractPackFromGraph,
  upsertCluster,
} from '@server/lib/mapping/graph';
import mappingService from '@server/lib/mapping/service';
import {
  refKey,
  type IdRef,
  type MappingCandidate,
  type MappingResolver,
  type Namespace,
} from '@server/lib/mapping/types';
import logger from '@server/logger';
import type { EntityManager } from 'typeorm';
import { PackFetchError, fetchPack, type PackCacheState } from './download';
import {
  parsePack,
  partitionPackRecord,
  validatePackBody,
  type PackRecord,
} from './formats';
import {
  extraMirrors,
  fetchManifest,
  type PackManifestEntry,
} from './manifest';
import {
  beginPackProgress,
  endPackProgress,
  reportDownloadBytes,
  updatePackProgress,
} from './progress';

/**
 * A pack's parsed contents, indexed for lookup.
 *
 * Kept in memory as an index of id -> record pointers rather than as clusters:
 * the graph is the persistent store, and this only exists so the first lookup
 * after a refresh does not require the whole pack to be ingested first.
 */
class PackIndex {
  private readonly byRef = new Map<string, PackRecord[]>();

  public constructor(records: PackRecord[]) {
    for (const record of records) {
      for (const ref of record.refs) {
        // Index both the season-scoped and the bare key so a season-less query
        // still finds a season-scoped record.
        for (const key of [refKey(ref), `${ref.ns}:${ref.id}`]) {
          const bucket = this.byRef.get(key);
          if (bucket) bucket.push(record);
          else this.byRef.set(key, [record]);
        }
      }
    }
  }

  public lookup(from: IdRef): PackRecord[] {
    const exact = this.byRef.get(refKey(from));
    if (exact?.length) return exact;
    const fallback = this.byRef.get(`${from.ns}:${from.id}`) ?? [];
    if (from.season === undefined) return fallback;
    return fallback.filter((record) =>
      record.refs.some(
        (ref) =>
          ref.ns === from.ns &&
          String(ref.id) === String(from.id) &&
          (ref.season === undefined || ref.season === from.season)
      )
    );
  }

  public get size(): number {
    return this.byRef.size;
  }
}

export interface LoadedPack {
  entry: PackManifestEntry;
  index: PackIndex;
  records: PackRecord[];
}

const loaded = new Map<string, LoadedPack>();
const packRefreshLocks = new Map<string, Promise<PackRefreshResult>>();

const MIN_DROP_COMPARE_COUNT = 50;
const MAX_PACK_DROP_RATIO = 0.5;

const trustFor = (entry: PackManifestEntry, ns: Namespace): number =>
  entry.namespaceTrust?.[ns] ?? entry.trust;

/** A declarative pack becomes a resolver without any pack-specific code. */
export function packResolver(pack: LoadedPack): MappingResolver {
  return {
    key: pack.entry.key,
    kind: 'pack',
    trust: pack.entry.trust,
    supports: () => true,
    resolve: async (from, to) => {
      const candidates: MappingCandidate[] = [];
      const seen = new Set<string>();
      for (const record of pack.index.lookup(from)) {
        for (const ref of record.refs) {
          if (ref.ns !== to) continue;
          if (refKey(ref) === refKey(from)) continue;
          // A season-scoped question must not be answered with a sibling season.
          if (
            from.season !== undefined &&
            ref.season !== undefined &&
            ref.season !== from.season &&
            ref.ns === from.ns
          ) {
            continue;
          }
          const key = refKey(ref);
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push({
            target: ref,
            confidence: trustFor(pack.entry, to),
            sourceKey: pack.entry.key,
            via: [from],
          });
        }
      }
      return candidates;
    },
  };
}

const cacheStateFor = async (key: string): Promise<PackCacheState> => {
  const row = await getRepository(MappingSource).findOne({ where: { key } });
  return {
    etag: row?.etag ?? undefined,
    lastModified: row?.lastModified ?? undefined,
  };
};

async function recordSourceState(
  entry: PackManifestEntry,
  patch: Partial<MappingSource>
): Promise<void> {
  const repository = getRepository(MappingSource);
  const now = new Date();
  const existing = await repository.findOne({ where: { key: entry.key } });
  const base = {
    key: entry.key,
    kind: 'pack' as const,
    format: entry.format,
    mirrors: entry.mirrors,
    priority: entry.priority,
    trust: entry.trust,
    namespaceTrust: entry.namespaceTrust ?? null,
    fieldMap: entry.fieldMap ?? null,
    namespaceMap: entry.namespaceMap ?? null,
    licence: entry.licence ?? null,
    legalNote: entry.legalNote ?? null,
    costClass: entry.costClass ?? 'bulk',
    updatedAt: now,
  };
  if (existing) {
    // `enabled` is operator-owned once the row exists; a manifest refresh must
    // not silently re-enable a pack an admin turned off (notably the unlicensed
    // anime-lists pack).
    await repository.update(existing.id, { ...base, ...patch });
    return;
  }
  await repository.insert({
    ...base,
    enabled: entry.enabled,
    createdAt: now,
    ...patch,
  });
}

export interface PackRefreshResult {
  key: string;
  status: 'downloaded' | 'notModified' | 'lastGood' | 'skipped' | 'failed';
  records?: number;
  clusters?: number;
  error?: string;
}

/**
 * Fetch, validate, parse, register, and ingest one pack.
 *
 * Ingestion writes into the graph so a restart does not need the pack at all;
 * the in-memory index only covers the window before ingestion completes and
 * lookups for records that failed to persist.
 */
export async function refreshPack(
  entry: PackManifestEntry,
  options: { ingest?: boolean; replacePackGraph?: boolean } = {}
): Promise<PackRefreshResult> {
  const existing = packRefreshLocks.get(entry.key);
  if (existing) return existing;
  const work = refreshPackUnlocked(entry, options).finally(() => {
    packRefreshLocks.delete(entry.key);
  });
  packRefreshLocks.set(entry.key, work);
  return work;
}

async function refreshPackUnlocked(
  entry: PackManifestEntry,
  options: { ingest?: boolean; replacePackGraph?: boolean } = {}
): Promise<PackRefreshResult> {
  const row = await getRepository(MappingSource).findOne({
    where: { key: entry.key },
  });
  const enabled = row ? row.enabled : entry.enabled;
  if (!enabled) {
    mappingService.unregister(entry.key);
    loaded.delete(entry.key);
    return { key: entry.key, status: 'skipped' };
  }

  const mirrors = [...entry.mirrors, ...extraMirrors(entry.key)];
  beginPackProgress(entry.key);
  try {
    let parsedRecords: PackRecord[] | undefined;
    const fetched = await fetchPack({
      key: entry.key,
      format: entry.format,
      mirrors,
      cache: await cacheStateFor(entry.key),
      validate: async (body) => {
        updatePackProgress(entry.key, { phase: 'validating' });
        validatePackBody(entry.format, body);
        const { records } = await parsePack(entry.format, body, {
          fieldMap: entry.fieldMap,
          typeFields: entry.typeFields,
          namespaceMap: entry.namespaceMap,
        });
        if (!records.length) {
          throw new Error('pack parsed to zero mapping records');
        }
        const previous =
          row?.entryCount ?? loaded.get(entry.key)?.records.length;
        if (
          previous !== undefined &&
          previous >= MIN_DROP_COMPARE_COUNT &&
          records.length < Math.ceil(previous * MAX_PACK_DROP_RATIO)
        ) {
          throw new Error(
            `pack dropped from ${previous} to ${records.length} records`
          );
        }
        parsedRecords = records;
      },
      onProgress: ({ received, total, mirror }) =>
        reportDownloadBytes(entry.key, received, total, mirror),
    });
    const body = fetched.body;
    if (!body) throw new Error('pack fetch returned no body');

    updatePackProgress(entry.key, { phase: 'parsing' });
    const records =
      parsedRecords ??
      (
        await parsePack(entry.format, body, {
          fieldMap: entry.fieldMap,
          typeFields: entry.typeFields,
          namespaceMap: entry.namespaceMap,
        })
      ).records;
    if (!records.length) {
      throw new Error('pack parsed to zero mapping records');
    }
    const pack: LoadedPack = { entry, index: new PackIndex(records), records };

    const shouldReplacePackGraph =
      fetched.status === 'downloaded' ||
      (Boolean(options.replacePackGraph) && fetched.status !== 'lastGood');
    let clusters = 0;
    if (
      options.ingest &&
      (shouldReplacePackGraph || fetched.status !== 'notModified')
    ) {
      if (shouldReplacePackGraph) {
        beginPackGraphRewrite();
        try {
          if (!mappingSourceContributes(entry.key)) {
            return { key: entry.key, status: 'skipped' };
          }
          clusters = await replacePackGraph(pack);
        } finally {
          endPackGraphRewrite();
        }
      } else {
        clusters = await ingestPack(pack);
      }
    }
    // This check and registration are synchronous, so a disable operation
    // either wins before publication or unregisters the resolver afterwards.
    if (!mappingSourceContributes(entry.key)) {
      loaded.delete(entry.key);
      mappingService.unregister(entry.key);
      return { key: entry.key, status: 'skipped' };
    }
    loaded.set(entry.key, pack);
    mappingService.register(packResolver(pack));
    mappingService.invalidate();
    await recordSourceState(entry, {
      etag: fetched.etag ?? null,
      lastModified: fetched.lastModified ?? null,
      version: fetched.sha256?.slice(0, 12) ?? null,
      lastFetchedAt: new Date(),
      lastSuccessAt: new Date(),
      lastError: null,
      entryCount: records.length,
      consecutiveFailures: 0,
    });
    logger.info(`Refreshed mapping pack ${entry.key}`, {
      label: 'Mapping',
      status: fetched.status,
      records: records.length,
      mirror: fetched.mirror,
      clusters,
    });
    return {
      key: entry.key,
      status: fetched.status,
      records: records.length,
      clusters,
    };
  } catch (error) {
    const message =
      error instanceof PackFetchError
        ? `${error.message}: ${error.attempts.map((a) => `${a.mirror} (${a.error})`).join('; ')}`
        : error instanceof Error
          ? error.message
          : String(error);
    await recordSourceState(entry, {
      lastFetchedAt: new Date(),
      lastError: message,
      consecutiveFailures: (row?.consecutiveFailures ?? 0) + 1,
    });
    logger.error(`Unable to refresh mapping pack ${entry.key}`, {
      label: 'Mapping',
      errorMessage: message,
    });
    return { key: entry.key, status: 'failed', error: message };
  } finally {
    endPackProgress(entry.key);
  }
}

/** Write a parsed pack into the persistent graph, in bounded batches. */
export async function ingestPack(
  pack: LoadedPack,
  manager?: EntityManager
): Promise<number> {
  let clusters = 0;
  const recordsTotal = pack.records.length;
  let recordsDone = 0;
  updatePackProgress(pack.entry.key, {
    phase: 'ingesting',
    recordsDone: 0,
    recordsTotal,
  });
  for (const record of pack.records) {
    recordsDone += 1;
    if (recordsDone === recordsTotal || recordsDone % 250 === 0) {
      updatePackProgress(pack.entry.key, {
        phase: 'ingesting',
        recordsDone,
        recordsTotal,
      });
    }
    for (const part of partitionPackRecord(record)) {
      const links = part.refs.map((ref) => ({
        ref,
        confidence: trustFor(pack.entry, ref.ns),
        sourceKey: pack.entry.key,
      }));
      try {
        const clusterId = await upsertCluster(
          links,
          {
            title: part.title,
            year: part.year,
          },
          manager
        );
        if (clusterId !== undefined) clusters += 1;
        if (clusterId !== undefined && part.episodeRules?.length) {
          for (const rule of part.episodeRules) {
            await upsertEpisodeRule(
              {
                clusterId,
                source: rule.source,
                target: rule.target,
                sourceRange: rule.sourceRange,
                targetRange: rule.targetRange,
                ratio: rule.ratio,
                confidence: trustFor(pack.entry, rule.target.ns),
                sourceKey: pack.entry.key,
              },
              manager
            );
          }
        }
      } catch (error) {
        if (manager) throw error;
        logger.debug('Unable to ingest mapping pack record', {
          label: 'Mapping',
          pack: pack.entry.key,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  mappingService.invalidate();
  return clusters;
}

/** Replace one pack's graph contribution as an all-or-nothing operation. */
export const replacePackGraph = (pack: LoadedPack): Promise<number> =>
  dataSource.transaction(async (manager) => {
    await retractPackFromGraph(pack.entry.key, manager);
    return ingestPack(pack, manager);
  });

export async function refreshAllPacks(
  options: { ingest?: boolean; manifestUrl?: string } = {}
): Promise<PackRefreshResult[]> {
  const manifest = await fetchManifest(options.manifestUrl);
  const ordered = [...manifest.packs].sort((a, b) => a.priority - b.priority);
  const results: PackRefreshResult[] = [];
  for (const entry of ordered) {
    results.push(await refreshPack(entry, { ingest: options.ingest }));
  }
  return results;
}

export const loadedPacks = (): LoadedPack[] => [...loaded.values()];

export const clearLoadedPacks = (): void => {
  for (const key of loaded.keys()) mappingService.unregister(key);
  loaded.clear();
};

export { PackIndex };
