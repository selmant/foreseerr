import { getRepository } from '@server/datasource';
import {
  MappingResolution,
  type MappingResolutionOrigin,
} from '@server/entity/MappingResolution';
import logger from '@server/logger';
import { Brackets, In, Not } from 'typeorm';
import type { IdRef, MediaType } from './types';

/** Origins that are an inference rather than a stated fact. */
export const GUESS_ORIGINS: MappingResolutionOrigin[] = ['title', 'prequel'];

const typeKey = (mediaType?: MediaType): string => mediaType ?? '';

export interface Correction {
  /** Null records "this has no TMDB counterpart". */
  tmdbId: number | null;
  tmdbType: MediaType | null;
}

/**
 * Every correction, held in memory. There are few of them, and the discover
 * routes ask about every tile, including ones whose id came from the source.
 */
let corrections: Promise<Map<string, Correction>> | undefined;

export const invalidateCorrections = (): void => {
  corrections = undefined;
};

const loadCorrections = (): Promise<Map<string, Correction>> => {
  corrections ??= getRepository(MappingResolution)
    .find({ where: { origin: 'manual' } })
    .then(
      (rows) =>
        new Map(
          rows.map((row) => [
            `${row.srcNs}:${row.srcId}`,
            {
              tmdbId: row.tmdbId ?? null,
              tmdbType: row.tmdbType ?? null,
            },
          ])
        )
    )
    .catch((error) => {
      corrections = undefined;
      throw error;
    });
  return corrections;
};

/** The admin's correction for the first of these ids that has one. */
export async function correctionFor(
  refs: (IdRef | undefined)[]
): Promise<Correction | undefined> {
  const known = await loadCorrections();
  for (const ref of refs) {
    const found = ref && known.get(`${ref.ns}:${ref.id}`);
    if (found) return found;
  }
  return undefined;
}

/** Stored rows for any of an item's ids, whatever media type they were filed under. */
export async function storedFor(refs: IdRef[]): Promise<MappingResolution[]> {
  if (!refs.length) return [];
  return getRepository(MappingResolution)
    .createQueryBuilder('resolution')
    .where(
      new Brackets((any) => {
        refs.forEach((ref, index) => {
          any.orWhere(
            `(resolution.srcNs = :ns${index} AND resolution.srcId = :id${index})`,
            { [`ns${index}`]: ref.ns, [`id${index}`]: String(ref.id) }
          );
        });
      })
    )
    .getMany();
}

export interface ResolutionWrite {
  ref: IdRef;
  mediaType?: MediaType;
  tmdbId?: number | null;
  tmdbType?: MediaType | null;
  origin: MappingResolutionOrigin;
  title?: string;
  year?: number;
  discoverSource?: string;
  detail?: string;
  hits?: number;
  /**
   * False for a bare sighting: it counts the hit but must not look like a
   * fresh attempt, or a popular unmapped item would never be retried.
   */
  attempted?: boolean;
  createdByUserId?: number;
}

/** `checkedAt` of a row no resolver has attempted yet. */
const NEVER = new Date(0);

/**
 * Store an answer or a miss for one id.
 *
 * A manual row is never overwritten by anything but another manual write, and a
 * miss never replaces an answer: both would let a transient failure erase a
 * correction.
 */
export async function saveResolution(
  write: ResolutionWrite,
  retried = false
): Promise<void> {
  const repository = getRepository(MappingResolution);
  const identity = {
    srcNs: write.ref.ns,
    srcId: String(write.ref.id),
    mediaType: write.origin === 'manual' ? '' : typeKey(write.mediaType),
  };
  const now = new Date();
  const hits = write.hits ?? 0;
  const attempted = write.attempted ?? true;
  // A correction is filed without a media type and answers for all of them, so
  // an item corrected to "no TMDB counterpart" must not reappear as unmapped.
  const existing =
    (write.origin === 'miss'
      ? await repository.findOne({
          where: { ...identity, mediaType: '', origin: 'manual' },
        })
      : null) ?? (await repository.findOne({ where: identity }));

  if (existing) {
    const keepAnswer =
      (existing.origin === 'manual' && write.origin !== 'manual') ||
      (write.origin === 'miss' && existing.origin !== 'miss');
    if (keepAnswer) {
      if (hits)
        await repository.increment({ id: existing.id }, 'hitCount', hits);
      return;
    }
    if (write.origin === 'manual' || existing.origin === 'manual') {
      invalidateCorrections();
    }
    await repository.update(existing.id, {
      tmdbId: write.tmdbId ?? null,
      tmdbType: write.tmdbType ?? null,
      origin: write.origin,
      hitCount: existing.hitCount + hits,
      ...(attempted ? { checkedAt: now } : {}),
      updatedAt: now,
      // A later bare sighting must not erase what an earlier one knew.
      ...(write.title ? { title: write.title } : {}),
      ...(write.year ? { year: write.year } : {}),
      ...(write.discoverSource ? { discoverSource: write.discoverSource } : {}),
      ...(write.detail !== undefined ? { detail: write.detail } : {}),
      ...(write.createdByUserId
        ? { createdByUserId: write.createdByUserId }
        : {}),
    });
    return;
  }

  try {
    await repository.insert({
      ...identity,
      tmdbId: write.tmdbId ?? null,
      tmdbType: write.tmdbType ?? null,
      origin: write.origin,
      title: write.title ?? null,
      year: write.year ?? null,
      discoverSource: write.discoverSource ?? null,
      detail: write.detail ?? null,
      hitCount: hits,
      createdByUserId: write.createdByUserId ?? null,
      checkedAt: attempted ? now : NEVER,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    // Two lookups of the same item raced to the insert; the row exists now,
    // so apply this write to it instead.
    if (retried) throw error;
    await saveResolution(write, true);
  }
  if (write.origin === 'manual') invalidateCorrections();
}

/**
 * Record an admin's correction and drop whatever was inferred for that id, so
 * the unmapped and guessed lists stop showing an item that is now settled.
 */
export async function saveManual(
  write: Omit<ResolutionWrite, 'origin' | 'mediaType'>
): Promise<void> {
  const repository = getRepository(MappingResolution);
  const inferred = await repository.find({
    where: {
      srcNs: write.ref.ns,
      srcId: String(write.ref.id),
      origin: Not('manual'),
    },
  });
  // Keep what the sightings knew about the item, so the correction is not
  // listed as a bare id.
  const known = inferred.find((row) => row.title) ?? inferred[0];
  await deleteResolutions(inferred.map((row) => row.id));
  await saveResolution({
    title: known?.title ?? undefined,
    year: known?.year ?? undefined,
    discoverSource: known?.discoverSource ?? undefined,
    ...write,
    origin: 'manual',
  });
}

export async function deleteResolutions(ids: number[]): Promise<void> {
  if (!ids.length) return;
  await getRepository(MappingResolution).delete(ids);
  invalidateCorrections();
}

export interface MissObservation {
  ref: IdRef;
  mediaType?: MediaType;
  title?: string;
  year?: number;
  discoverSource?: string;
  detail?: string;
}

const missKey = (observation: MissObservation): string =>
  `${observation.ref.ns}:${observation.ref.id}:${typeKey(observation.mediaType)}`;

/**
 * Sliders re-render constantly, so identical sightings within one window are
 * folded in memory before touching the database.
 */
const FLUSH_WINDOW_MSEC = 5000;
const pending = new Map<
  string,
  { observation: MissObservation; hits: number }
>();
let flushTimer: NodeJS.Timeout | undefined;

async function flush(): Promise<void> {
  flushTimer = undefined;
  const batch = [...pending.values()];
  pending.clear();
  for (const { observation, hits } of batch) {
    try {
      await saveResolution({
        ...observation,
        origin: 'miss',
        hits,
        attempted: false,
      });
    } catch (error) {
      logger.debug('Unable to record unmapped item', {
        label: 'Mapping',
        ref: `${observation.ref.ns}:${observation.ref.id}`,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Count a sighting of an item that has no TMDB id. Never throws: telemetry must
 * not be able to break a slider.
 */
export function recordMiss(observation: MissObservation): void {
  if (!observation.ref.id) return;
  const key = missKey(observation);
  const existing = pending.get(key);
  if (existing) {
    existing.hits += 1;
    existing.observation = { ...existing.observation, ...observation };
  } else {
    pending.set(key, { observation, hits: 1 });
  }
  if (!flushTimer) {
    flushTimer = setTimeout(() => void flush(), FLUSH_WINDOW_MSEC);
    flushTimer.unref?.();
  }
}

export async function flushMisses(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  await flush();
}

/** Drop pending telemetry so it cannot flush into another test's database. */
export function resetMissBuffer(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  pending.clear();
}

export type ResolutionList = 'unmapped' | 'manual' | 'guessed';

const ORIGINS: Record<ResolutionList, MappingResolutionOrigin[]> = {
  unmapped: ['miss'],
  manual: ['manual'],
  guessed: GUESS_ORIGINS,
};

export async function listResolutions(
  list: ResolutionList,
  { take = 50, skip = 0 }: { take?: number; skip?: number } = {}
): Promise<{ results: MappingResolution[]; total: number }> {
  const [results, total] = await getRepository(MappingResolution).findAndCount({
    where: { origin: In(ORIGINS[list]) },
    order:
      list === 'unmapped'
        ? { hitCount: 'DESC', updatedAt: 'DESC' }
        : { updatedAt: 'DESC' },
    take: Math.min(1000, Math.max(1, take)),
    skip: Math.max(0, skip),
  });
  return { results, total };
}

export async function countResolutions(): Promise<
  Record<ResolutionList, number>
> {
  const repository = getRepository(MappingResolution);
  const [unmapped, manual, guessed] = await Promise.all(
    (['unmapped', 'manual', 'guessed'] as const).map((list) =>
      repository.count({ where: { origin: In(ORIGINS[list]) } })
    )
  );
  return { unmapped, manual, guessed };
}
