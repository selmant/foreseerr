import type TheMovieDb from '@server/api/themoviedb';
import type {
  TraktBrowseMediaType,
  TraktListSortBy,
  TraktMediaItem,
} from '@server/api/trakt/interfaces';
import cacheManager from '@server/lib/cache';
import {
  EXTERNAL_ENRICHMENT_CONCURRENCY,
  mapWithConcurrency,
} from '@server/lib/concurrency';
import { paginateSortedTraktItems } from '@server/lib/trakt/mixedPagination';

const MAX_TRAKT_PAGES = 10;
const ANIME_CACHE_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

async function hasAnimeKeyword(
  tmdb: TheMovieDb,
  item: TraktMediaItem
): Promise<boolean> {
  const cache = cacheManager.getCache('tmdb');
  const cacheKey = `anime-keyword:${item.mediaType}:${item.tmdbId}`;
  const cached = cache.data.get<boolean>(cacheKey);
  if (typeof cached === 'boolean') {
    return cached;
  }

  const isAnime = await tmdb.mediaHasAnimeKeyword({
    mediaType: item.mediaType,
    tmdbId: item.tmdbId,
  });
  cache.data.set(cacheKey, isAnime, ANIME_CACHE_TTL_SECONDS);
  return isAnime;
}

async function classifyTraktItemsByAnime(
  items: TraktMediaItem[],
  tmdb: TheMovieDb
): Promise<{ item: TraktMediaItem; isAnime: boolean }[]> {
  return mapWithConcurrency(
    items,
    EXTERNAL_ENRICHMENT_CONCURRENCY,
    async (item) => ({
      item,
      isAnime: await hasAnimeKeyword(tmdb, item),
    })
  );
}

export async function filterTraktAnimeItems(
  items: TraktMediaItem[],
  tmdb: TheMovieDb
): Promise<TraktMediaItem[]> {
  if (!items.length) {
    return [];
  }

  const results = await classifyTraktItemsByAnime(items, tmdb);
  return results
    .filter((result) => result.isAnime)
    .map((result) => result.item);
}

export async function excludeTraktAnimeItems(
  items: TraktMediaItem[],
  tmdb: TheMovieDb
): Promise<TraktMediaItem[]> {
  if (!items.length) {
    return [];
  }

  const results = await classifyTraktItemsByAnime(items, tmdb);
  return results
    .filter((result) => !result.isAnime)
    .map((result) => result.item);
}

export async function fetchPaginatedTraktFilteredItems(
  fetchPage: (page: number) => Promise<TraktMediaItem[]>,
  page: number,
  itemsPerPage: number,
  filterItems: (items: TraktMediaItem[]) => Promise<TraktMediaItem[]>,
  sortBy?: TraktListSortBy
): Promise<{ items: TraktMediaItem[]; hasMore: boolean }> {
  const needed = page * itemsPerPage;
  const filtered: TraktMediaItem[] = [];
  let traktPage = 1;
  let lastBatchFull = false;

  while (traktPage <= MAX_TRAKT_PAGES) {
    const batch = await fetchPage(traktPage);
    if (!batch.length) {
      lastBatchFull = false;
      break;
    }

    lastBatchFull = batch.length >= itemsPerPage;
    filtered.push(...(await filterItems(batch)));

    if (!lastBatchFull) {
      break;
    }

    if (!sortBy && filtered.length >= needed) {
      break;
    }

    traktPage++;
  }

  if (sortBy) {
    return paginateSortedTraktItems(filtered, {
      page,
      limit: itemsPerPage,
      sortBy,
      hasMoreUpstream: lastBatchFull && traktPage <= MAX_TRAKT_PAGES,
    });
  }

  const start = (page - 1) * itemsPerPage;
  const items = filtered.slice(start, start + itemsPerPage);
  const hasMore =
    filtered.length > start + itemsPerPage ||
    (lastBatchFull && traktPage <= MAX_TRAKT_PAGES);

  return { items, hasMore };
}

export async function fetchPaginatedTraktAnimeItems(
  fetchPage: (page: number) => Promise<TraktMediaItem[]>,
  page: number,
  itemsPerPage: number,
  tmdb: TheMovieDb,
  sortBy?: TraktListSortBy
): Promise<{ items: TraktMediaItem[]; hasMore: boolean }> {
  return fetchPaginatedTraktFilteredItems(
    fetchPage,
    page,
    itemsPerPage,
    (items) => filterTraktAnimeItems(items, tmdb),
    sortBy
  );
}

export async function fetchPaginatedTraktNonAnimeItems(
  fetchPage: (page: number) => Promise<TraktMediaItem[]>,
  page: number,
  itemsPerPage: number,
  tmdb: TheMovieDb,
  sortBy?: TraktListSortBy
): Promise<{ items: TraktMediaItem[]; hasMore: boolean }> {
  return fetchPaginatedTraktFilteredItems(
    fetchPage,
    page,
    itemsPerPage,
    (items) => excludeTraktAnimeItems(items, tmdb),
    sortBy
  );
}

export async function applyTraktMediaTypeFilter(
  items: TraktMediaItem[],
  mediaType: TraktBrowseMediaType,
  tmdb: TheMovieDb
): Promise<TraktMediaItem[]> {
  if (mediaType === 'anime') {
    return filterTraktAnimeItems(items, tmdb);
  }

  if (mediaType === 'tv') {
    return excludeTraktAnimeItems(items, tmdb);
  }

  return items;
}

/**
 * Classify a chunk for progressive recommendation filtering.
 * movie/all → pass through; anime → keep anime; tv → drop anime.
 */
export async function filterTraktMediaTypeChunk(
  items: TraktMediaItem[],
  mediaType: TraktBrowseMediaType,
  tmdb: TheMovieDb
): Promise<TraktMediaItem[]> {
  if (!items.length || mediaType === 'movie' || mediaType === 'all') {
    return items;
  }

  const results = await classifyTraktItemsByAnime(items, tmdb);
  if (mediaType === 'anime') {
    return results.filter((r) => r.isAnime).map((r) => r.item);
  }
  return results.filter((r) => !r.isAnime).map((r) => r.item);
}
