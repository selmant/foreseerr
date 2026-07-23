import type TheMovieDb from '@server/api/themoviedb';
import type TraktAPI from '@server/api/trakt';
import { TRAKT_RECOMMENDATIONS_LIMIT_MAX } from '@server/api/trakt';
import type {
  TraktBrowseMediaType,
  TraktFetchMediaType,
  TraktMediaItem,
} from '@server/api/trakt/interfaces';
import cacheManager from '@server/lib/cache';
import { filterTraktMediaTypeChunk } from '@server/lib/trakt/animeFilter';
import {
  filterWatchedTraktItems,
  loadWatchedIdSets,
  type WatchedIdSets,
} from '@server/lib/trakt/hideWatched';

export const TRAKT_RECOMMENDATIONS_ITEMS_PER_PAGE = 20;
/** Recommendations change slowly — keep the raw pool warm for an hour. */
export const TRAKT_RECOMMENDATIONS_CACHE_TTL_SECONDS = 3600;
/** Classify this many raw items per progressive step. */
export const TRAKT_RECS_CLASSIFY_CHUNK = 20;

export interface TraktRecommendationQueryOptions {
  mediaType: TraktBrowseMediaType;
  ignoreCollected: boolean;
  ignoreWatchlisted: boolean;
  ignoreWatched: boolean;
  extended?: 'min' | 'full';
}

export type RecsPoolCache = {
  raw: TraktMediaItem[];
  kept: TraktMediaItem[];
  cursor: number;
  complete: boolean;
};

const inflightRaw = new Map<string, Promise<TraktMediaItem[]>>();
const inflightAdvance = new Map<string, Promise<void>>();

async function fetchRawTraktRecommendations(
  trakt: TraktAPI,
  mediaType: TraktFetchMediaType,
  options: Pick<
    TraktRecommendationQueryOptions,
    'ignoreCollected' | 'ignoreWatchlisted' | 'extended'
  >
): Promise<TraktMediaItem[]> {
  const recommendationOptions = {
    limit: TRAKT_RECOMMENDATIONS_LIMIT_MAX,
    ignoreCollected: options.ignoreCollected,
    ignoreWatchlisted: options.ignoreWatchlisted,
    extended: options.extended ?? 'min',
  };

  if (mediaType === 'all') {
    const [movies, shows] = await Promise.all([
      trakt.getRecommendations('movie', recommendationOptions),
      trakt.getRecommendations('tv', recommendationOptions),
    ]);
    const items: TraktMediaItem[] = [];
    const maxLen = Math.max(movies.length, shows.length);
    for (let i = 0; i < maxLen; i++) {
      if (movies[i]) {
        items.push(movies[i]);
      }
      if (shows[i]) {
        items.push(shows[i]);
      }
    }
    return items;
  }

  return trakt.getRecommendations(mediaType, recommendationOptions);
}

/**
 * Cache key excludes ignoreWatched — watched is applied live at serve time
 * so mark-watched + hide-watched stays correct without a 1h stale pool.
 */
function recommendationsCacheKey(
  userId: number,
  options: TraktRecommendationQueryOptions
): string {
  return `recommendations:${userId}:${options.mediaType}:${options.ignoreCollected}:${options.ignoreWatchlisted}:${options.extended ?? 'min'}`;
}

function fetchTypeForMediaType(
  mediaType: TraktRecommendationQueryOptions['mediaType']
): TraktFetchMediaType {
  if (mediaType === 'anime') {
    return 'all';
  }
  return mediaType;
}

/**
 * Load (or fetch) the raw Trakt pool (no watched filter). Single-flight per key.
 */
async function getOrFetchRawPool(
  trakt: TraktAPI,
  options: TraktRecommendationQueryOptions,
  cacheKey: string
): Promise<TraktMediaItem[]> {
  const cache = cacheManager.getCache('trakt');
  const existing = cache.data.get<RecsPoolCache>(cacheKey);
  if (existing) {
    return existing.raw;
  }

  let pending = inflightRaw.get(cacheKey);
  if (!pending) {
    pending = (async () =>
      fetchRawTraktRecommendations(
        trakt,
        fetchTypeForMediaType(options.mediaType),
        options
      ))().finally(() => {
      inflightRaw.delete(cacheKey);
    });
    inflightRaw.set(cacheKey, pending);
  }

  return pending;
}

function getOrCreatePool(
  cacheKey: string,
  raw: TraktMediaItem[],
  mediaType: TraktRecommendationQueryOptions['mediaType']
): RecsPoolCache {
  const cache = cacheManager.getCache('trakt');
  const existing = cache.data.get<RecsPoolCache>(cacheKey);
  if (existing) {
    return existing;
  }

  // movie/all: no anime keyword work — keep entire raw pool immediately
  if (mediaType === 'movie' || mediaType === 'all') {
    const pool: RecsPoolCache = {
      raw,
      kept: [...raw],
      cursor: raw.length,
      complete: true,
    };
    cache.data.set(cacheKey, pool, TRAKT_RECOMMENDATIONS_CACHE_TTL_SECONDS);
    return pool;
  }

  const pool: RecsPoolCache = {
    raw,
    kept: [],
    cursor: 0,
    complete: raw.length === 0,
  };
  cache.data.set(cacheKey, pool, TRAKT_RECOMMENDATIONS_CACHE_TTL_SECONDS);
  return pool;
}

/**
 * Advance anime classification until `kept` has at least `needed` items (or raw exhausted).
 * Serialized per cache key so concurrent page requests don't double-classify.
 */
export async function advanceRecsPoolClassification(
  pool: RecsPoolCache,
  mediaType: TraktRecommendationQueryOptions['mediaType'],
  tmdb: TheMovieDb,
  needed: number,
  cacheKey?: string
): Promise<void> {
  if (
    pool.complete ||
    pool.kept.length >= needed ||
    mediaType === 'movie' ||
    mediaType === 'all'
  ) {
    return;
  }

  const run = async () => {
    while (!pool.complete && pool.kept.length < needed) {
      const chunk = pool.raw.slice(
        pool.cursor,
        pool.cursor + TRAKT_RECS_CLASSIFY_CHUNK
      );
      if (!chunk.length) {
        pool.complete = true;
        break;
      }

      const keptChunk = await filterTraktMediaTypeChunk(chunk, mediaType, tmdb);
      pool.kept.push(...keptChunk);
      pool.cursor += chunk.length;

      if (pool.cursor >= pool.raw.length) {
        pool.complete = true;
      }
    }

    if (cacheKey) {
      cacheManager
        .getCache('trakt')
        .data.set(cacheKey, pool, TRAKT_RECOMMENDATIONS_CACHE_TTL_SECONDS);
    }
  };

  if (!cacheKey) {
    await run();
    return;
  }

  const prev = inflightAdvance.get(cacheKey) ?? Promise.resolve();
  const next = prev.then(run, run).finally(() => {
    if (inflightAdvance.get(cacheKey) === next) {
      inflightAdvance.delete(cacheKey);
    }
  });
  inflightAdvance.set(cacheKey, next);
  await next;
}

async function visibleFromKept(
  kept: TraktMediaItem[],
  ignoreWatched: boolean,
  userId: number,
  trakt: TraktAPI,
  watchedSets?: WatchedIdSets
): Promise<TraktMediaItem[]> {
  if (!ignoreWatched) {
    return kept;
  }
  const sets = watchedSets ?? (await loadWatchedIdSets(userId, trakt));
  return filterWatchedTraktItems(kept, sets);
}

export async function getTraktRecommendationPage(
  userId: number,
  trakt: TraktAPI,
  tmdb: TheMovieDb,
  options: TraktRecommendationQueryOptions,
  page = 1,
  itemsPerPage = TRAKT_RECOMMENDATIONS_ITEMS_PER_PAGE
): Promise<{
  pageItems: TraktMediaItem[];
  hasMore: boolean;
  totalPages?: number;
  totalResults?: number;
}> {
  const safePage = Math.max(1, page);
  const pageSize = Math.max(1, itemsPerPage);
  const needed = safePage * pageSize;
  const cacheKey = recommendationsCacheKey(userId, options);

  const raw = await getOrFetchRawPool(trakt, options, cacheKey);
  const pool = getOrCreatePool(cacheKey, raw, options.mediaType);

  const watchedSets = options.ignoreWatched
    ? await loadWatchedIdSets(userId, trakt)
    : undefined;

  // Classify until we have enough *visible* (unwatched) items for this page.
  let visible = await visibleFromKept(
    pool.kept,
    options.ignoreWatched,
    userId,
    trakt,
    watchedSets
  );

  while (visible.length < needed && !pool.complete) {
    const nextTarget = Math.max(
      needed,
      pool.kept.length + TRAKT_RECS_CLASSIFY_CHUNK
    );
    await advanceRecsPoolClassification(
      pool,
      options.mediaType,
      tmdb,
      nextTarget,
      cacheKey
    );
    visible = await visibleFromKept(
      pool.kept,
      options.ignoreWatched,
      userId,
      trakt,
      watchedSets
    );
  }

  const offset = (safePage - 1) * pageSize;
  const pageItems = visible.slice(offset, offset + pageSize);
  const hasMore =
    visible.length > offset + pageSize ||
    (!pool.complete && pageItems.length > 0);

  if (!pool.complete) {
    return {
      pageItems,
      hasMore,
    };
  }

  return {
    pageItems,
    hasMore,
    totalPages: Math.max(1, Math.ceil(visible.length / pageSize)),
    totalResults: visible.length,
  };
}
