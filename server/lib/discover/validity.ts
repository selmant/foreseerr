import type TheMovieDb from '@server/api/themoviedb';
import type { DiscoverMappingInfo } from '@server/interfaces/api/discoverInterfaces';
import { BoundedLru } from '@server/lib/mapping/lru';
import { correctionFor, recordMiss } from '@server/lib/mapping/resolutions';
import { resolveTmdb } from '@server/lib/mapping/resolve';
import { tmdbRecord, type TmdbProbe } from '@server/lib/mapping/tmdb';
import { tmdbNamespace, type IdRef } from '@server/lib/mapping/types';
import logger from '@server/logger';

/**
 * A present id is not a valid id.
 *
 * Three couchmoney list items carried ids that are non-null, plausible, and
 * dead on TMDB (`tmdb_movie:434021`, `tmdb_movie:328440`, `tmdb_show:327100`).
 * They passed `hasDiscoverTmdbId`, so the server counted them as mapped, the
 * card then failed to load and drew an "Unmapped" ribbon, and clicking one
 * returned a 500. Confirming the id before trusting it is what makes the
 * backend and the frontend agree on what "mapped" means.
 */

/** Confirmed-alive ids change rarely; a dead id must not be re-probed per render. */
const ALIVE_TTL_MSEC = 24 * 3600 * 1000;
const alive = new BoundedLru<string, TmdbProbe>(20_000, ALIVE_TTL_MSEC);

export const resetTmdbValidityCache = (): void => alive.clear();

async function probe(
  mediaType: 'movie' | 'tv',
  tmdbId: number,
  tmdb?: TheMovieDb
): Promise<TmdbProbe> {
  const key = `${mediaType}:${tmdbId}`;
  const cached = alive.get(key);
  if (cached) return cached;
  try {
    const record = await tmdbRecord(mediaType, tmdbId, tmdb);
    // Only the positive answer is cached here; `tmdbRecord` negative-caches
    // misses with its own TTL, so a deleted id can come back without a restart.
    if (record.alive) alive.set(key, record);
    return record;
  } catch {
    // A timeout/429/5xx is not proof the id is dead; keep the tile until a
    // confirmed 404 arrives.
    return { alive: true };
  }
}

export async function confirmTmdbId(
  mediaType: 'movie' | 'tv',
  tmdbId: number,
  tmdb?: TheMovieDb
): Promise<boolean> {
  return (await probe(mediaType, tmdbId, tmdb)).alive;
}

export type TmdbTileArt = Pick<
  TmdbProbe,
  'posterPath' | 'backdropPath' | 'releaseDate' | 'firstAirDate'
>;

/**
 * Poster, backdrop, and date from the cached confirm probe. No extra request
 * when the id was already checked; empty when the id is dead.
 */
export async function tmdbTileArt(
  mediaType: 'movie' | 'tv',
  tmdbId: number,
  tmdb?: TheMovieDb
): Promise<TmdbTileArt> {
  const record = await probe(mediaType, tmdbId, tmdb);
  if (!record.alive) return {};
  return {
    ...(record.posterPath ? { posterPath: record.posterPath } : {}),
    ...(record.backdropPath ? { backdropPath: record.backdropPath } : {}),
    ...(record.releaseDate ? { releaseDate: record.releaseDate } : {}),
    ...(record.firstAirDate ? { firstAirDate: record.firstAirDate } : {}),
  };
}

export interface RepairRequest {
  /** Ids the source supplied, in the order they resolve most reliably. */
  refs: IdRef[];
  /** What the item is filed under, e.g. its Trakt slug. */
  identity?: IdRef;
  mediaType: 'movie' | 'tv';
  /** The id that failed confirmation, kept for the audit trail. */
  deadTmdbId: number;
  title?: string;
  year?: number;
  discoverSource?: string;
  offline?: boolean;
  tmdb?: TheMovieDb;
}

export interface RepairResult {
  tmdbId?: number;
  /** Which resolution step found the replacement. */
  origin?: string;
}

/**
 * Recover from a dead id using the other ids the source supplied.
 *
 * Trakt keeps separate records for Extended and Black & Chrome cuts that TMDB
 * has since merged away, so the cut-specific id 404s while the base film is
 * perfectly reachable through the same record's IMDB id. Each id is asked on
 * its own, so one that still answers with the dead record does not stop the
 * next from being tried.
 */
export async function repairDeadTmdbId(
  request: RepairRequest
): Promise<RepairResult> {
  for (const ref of request.refs) {
    const resolution = await resolveTmdb({
      refs: [ref],
      identity: request.identity,
      mediaType: request.mediaType,
      title: request.title,
      year: request.year,
      discoverSource: request.discoverSource,
      offline: request.offline,
      tmdb: request.tmdb,
    });
    if (!resolution || resolution.mediaType !== request.mediaType) continue;
    if (resolution.tmdbId === request.deadTmdbId) continue;
    // The replacement is only an improvement if it is actually alive.
    if (
      !(await confirmTmdbId(request.mediaType, resolution.tmdbId, request.tmdb))
    ) {
      continue;
    }
    return { tmdbId: resolution.tmdbId, origin: resolution.origin };
  }
  return {};
}

export interface ConfirmableItem {
  tmdbId?: number;
  mediaType: 'movie' | 'tv';
  title?: string;
  year?: number;
  refs?: IdRef[];
}

export interface ConfirmedItem {
  /** Undefined when the id was dead and could not be repaired. */
  tmdbId?: number;
  /** Set when a correction says the item is the other type. */
  mediaType?: 'movie' | 'tv';
  mappingState: DiscoverMappingInfo;
}

/**
 * Confirm one item's id, repairing or demoting it when the id is dead. Returns
 * undefined when the id is fine. An id that stays dead is counted in the
 * unmapped list, so the failure is measurable instead of being a broken card.
 *
 * An admin's correction for the item wins over the id the source supplied,
 * whether that id is dead or not.
 */
export async function confirmOrRepair(
  item: ConfirmableItem,
  options: {
    discoverSource?: string;
    offline?: boolean;
    namespace?: IdRef;
    tmdb?: TheMovieDb;
  } = {}
): Promise<ConfirmedItem | undefined> {
  const tmdbId = item.tmdbId;
  if (!tmdbId || tmdbId <= 0) return undefined;

  const identity = options.namespace ?? item.refs?.[0];
  const source = identity
    ? { namespace: identity.ns, externalId: String(identity.id) }
    : {};

  const correction = await correctionFor([identity, ...(item.refs ?? [])]);
  if (correction) {
    if (
      correction.tmdbId === tmdbId &&
      (correction.tmdbType ?? item.mediaType) === item.mediaType
    ) {
      return undefined;
    }
    return {
      tmdbId: correction.tmdbId ?? undefined,
      ...(correction.tmdbType ? { mediaType: correction.tmdbType } : {}),
      mappingState: {
        state: correction.tmdbId ? 'mapped' : 'unmapped',
        sourceKey: 'manual',
        ...source,
      },
    };
  }

  const record = await probe(item.mediaType, tmdbId, options.tmdb);
  if (record.alive) return undefined;

  const repair = await repairDeadTmdbId({
    refs: item.refs ?? [],
    identity,
    mediaType: item.mediaType,
    deadTmdbId: tmdbId,
    title: item.title,
    year: item.year,
    discoverSource: options.discoverSource,
    offline: options.offline,
    tmdb: options.tmdb,
  });

  if (repair.tmdbId) {
    logger.debug('Recovered a dead TMDB id from the source ids', {
      label: 'Mapping',
      was: `${tmdbNamespace(item.mediaType)}:${tmdbId}`,
      now: repair.tmdbId,
      discoverSource: options.discoverSource,
    });
    return {
      tmdbId: repair.tmdbId,
      mappingState: { state: 'mapped', sourceKey: repair.origin, ...source },
    };
  }

  if (identity) {
    recordMiss({
      ref: identity,
      mediaType: item.mediaType,
      title: item.title,
      year: item.year,
      discoverSource: options.discoverSource,
      detail: `TMDB ${item.mediaType} ${tmdbId} no longer exists`,
    });
  }
  return {
    tmdbId: undefined,
    mappingState: { state: 'unmapped', sourceKey: 'tmdb-confirm', ...source },
  };
}
