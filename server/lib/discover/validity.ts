import type TheMovieDb from '@server/api/themoviedb';
import type { DiscoverMappingInfo } from '@server/interfaces/api/discoverInterfaces';
import { ensureMappingLayer } from '@server/lib/mapping/bootstrap';
import { recordMappingGap } from '@server/lib/mapping/gaps';
import { normalizeTitle, titleScore } from '@server/lib/mapping/heuristic';
import { tmdbRecord, type TmdbProbe } from '@server/lib/mapping/live/tmdbFind';
import { BoundedLru } from '@server/lib/mapping/lru';
import mappingService from '@server/lib/mapping/service';
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

/**
 * Whether what the source calls an item and what TMDB calls it are far enough
 * apart to be worth a human look.
 *
 * Deliberately blunt, and deliberately advisory. A title check cannot decide a
 * mapping: roughly 40% of the mismatches an earlier similarity gate flagged
 * were correct, defeated by romaji against English (`Kimi no Na wa.` is *Your
 * Name.*). So this only fires when the years are far apart *as well*, which is
 * the shape of the real failure — a 1949 German film rendered as a 2023 anime —
 * and even then it only files a review item.
 */
const divergent = (
  source: { title?: string; year?: number },
  record: TmdbProbe
): boolean => {
  if (!source.title || !source.year || !record.year) return false;
  if (Math.abs(source.year - record.year) < 5) return false;
  const best = Math.max(
    titleScore(
      normalizeTitle(source.title),
      normalizeTitle(record.title ?? '')
    ),
    titleScore(
      normalizeTitle(source.title),
      normalizeTitle(record.originalTitle ?? '')
    )
  );
  return best < 40;
};

export interface RepairRequest {
  /** Ids the source supplied, in the order they resolve most reliably. */
  refs: IdRef[];
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
  ambiguous: boolean;
  sourceKey?: string;
  confidence?: number;
}

/**
 * Recover from a dead id using the other ids the source supplied.
 *
 * Trakt keeps separate records for Extended and Black & Chrome cuts that TMDB
 * has since merged away, so the cut-specific id 404s while the base film is
 * perfectly reachable through the same record's IMDB id. Where TMDB has instead
 * *split* one show into per-cour series the answer is genuinely two ids, and
 * that must surface as an ambiguity rather than a coin toss.
 */
export async function repairDeadTmdbId(
  request: RepairRequest
): Promise<RepairResult> {
  if (!request.refs.length) return { ambiguous: false };
  ensureMappingLayer();

  const target = tmdbNamespace(request.mediaType);
  let ambiguous = false;

  for (const ref of request.refs) {
    try {
      const resolution = await mappingService.resolve(ref, target, {
        discoverSource: request.discoverSource,
        offline: request.offline,
        title: request.title,
        year: request.year,
        mediaType: request.mediaType,
      });
      if (resolution.ambiguous) ambiguous = true;

      const candidate = Number(resolution.target?.id);
      if (!(candidate > 0) || candidate === request.deadTmdbId) continue;
      // The replacement is only an improvement if it is actually alive.
      if (!(await confirmTmdbId(request.mediaType, candidate, request.tmdb)))
        continue;

      return {
        tmdbId: candidate,
        ambiguous: false,
        sourceKey: resolution.sourceKey,
        confidence: resolution.confidence,
      };
    } catch (error) {
      logger.debug('Unable to repair a dead TMDB id', {
        label: 'Mapping',
        from: `${ref.ns}:${ref.id}`,
        deadTmdbId: request.deadTmdbId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { ambiguous };
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
  mappingState: DiscoverMappingInfo;
}

/**
 * Confirm one item's id, repairing or demoting it when the id is dead. Records
 * a `phantom` gap so the failure is measurable instead of being a broken card
 * nobody counts.
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

  const record = await probe(item.mediaType, tmdbId, options.tmdb);
  if (record.alive) {
    // The id works, so the item renders either way. Nothing compares the title
    // the source supplied with the one the card draws, so a silent disagreement
    // is invisible today; recording it is what makes it reviewable.
    const identity = options.namespace ?? item.refs?.[0];
    if (identity && divergent(item, record)) {
      recordMappingGap({
        namespace: identity.ns,
        externalId: String(identity.id),
        title: item.title,
        year: item.year,
        mediaType: item.mediaType,
        discoverSource: options.discoverSource,
        reason: 'ambiguous',
        rejectedTarget: `${tmdbNamespace(item.mediaType)}:${tmdbId}`,
        sourceKey: 'title-divergence',
      });
    }
    return undefined;
  }

  const deadRef = `${tmdbNamespace(item.mediaType)}:${tmdbId}`;
  const repair = await repairDeadTmdbId({
    refs: item.refs ?? [],
    mediaType: item.mediaType,
    deadTmdbId: tmdbId,
    title: item.title,
    year: item.year,
    discoverSource: options.discoverSource,
    offline: options.offline,
    tmdb: options.tmdb,
  });

  const identity = options.namespace ?? item.refs?.[0];
  if (identity) {
    recordMappingGap({
      namespace: identity.ns,
      externalId: String(identity.id),
      title: item.title,
      year: item.year,
      mediaType: item.mediaType,
      discoverSource: options.discoverSource,
      reason: repair.ambiguous ? 'ambiguous' : 'phantom',
      rejectedTarget: deadRef,
      sourceKey: repair.sourceKey ?? 'tmdb-confirm',
    });
  }

  if (repair.tmdbId) {
    logger.debug('Recovered a dead TMDB id from the source ids', {
      label: 'Mapping',
      was: deadRef,
      now: repair.tmdbId,
      discoverSource: options.discoverSource,
    });
    return {
      tmdbId: repair.tmdbId,
      mappingState: {
        state: 'mapped',
        sourceKey: repair.sourceKey,
        confidence: repair.confidence,
        ...(identity
          ? { namespace: identity.ns, externalId: String(identity.id) }
          : {}),
      },
    };
  }

  return {
    tmdbId: undefined,
    mappingState: {
      state: repair.ambiguous ? 'ambiguous' : 'unmapped',
      sourceKey: 'tmdb-confirm',
      ...(identity
        ? { namespace: identity.ns, externalId: String(identity.id) }
        : {}),
    },
  };
}
