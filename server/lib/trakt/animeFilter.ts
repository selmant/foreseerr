import type TheMovieDb from '@server/api/themoviedb';
import type { TraktMediaItem } from '@server/api/trakt/interfaces';

const MAX_TRAKT_PAGES = 10;

async function hasAnimeKeyword(
  tmdb: TheMovieDb,
  item: TraktMediaItem
): Promise<boolean> {
  return tmdb.mediaHasAnimeKeyword({
    mediaType: item.mediaType,
    tmdbId: item.tmdbId,
  });
}

async function classifyTraktItemsByAnime(
  items: TraktMediaItem[],
  tmdb: TheMovieDb
): Promise<{ item: TraktMediaItem; isAnime: boolean }[]> {
  return Promise.all(
    items.map(async (item) => ({
      item,
      isAnime: await hasAnimeKeyword(tmdb, item),
    }))
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
  filterItems: (items: TraktMediaItem[]) => Promise<TraktMediaItem[]>
): Promise<{ items: TraktMediaItem[]; hasMore: boolean }> {
  const needed = page * itemsPerPage;
  const filtered: TraktMediaItem[] = [];
  let traktPage = 1;
  let lastBatchFull = false;

  while (filtered.length < needed && traktPage <= MAX_TRAKT_PAGES) {
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

    traktPage++;
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
  tmdb: TheMovieDb
): Promise<{ items: TraktMediaItem[]; hasMore: boolean }> {
  return fetchPaginatedTraktFilteredItems(
    fetchPage,
    page,
    itemsPerPage,
    (items) => filterTraktAnimeItems(items, tmdb)
  );
}

export async function fetchPaginatedTraktNonAnimeItems(
  fetchPage: (page: number) => Promise<TraktMediaItem[]>,
  page: number,
  itemsPerPage: number,
  tmdb: TheMovieDb
): Promise<{ items: TraktMediaItem[]; hasMore: boolean }> {
  return fetchPaginatedTraktFilteredItems(
    fetchPage,
    page,
    itemsPerPage,
    (items) => excludeTraktAnimeItems(items, tmdb)
  );
}

export async function applyTraktMediaTypeFilter(
  items: TraktMediaItem[],
  mediaType: 'movie' | 'tv' | 'both' | 'anime',
  tmdb: TheMovieDb
): Promise<TraktMediaItem[]> {
  if (mediaType === 'anime') {
    return filterTraktAnimeItems(items, tmdb);
  }

  if (mediaType === 'tv' || mediaType === 'both') {
    return excludeTraktAnimeItems(items, tmdb);
  }

  return items;
}
