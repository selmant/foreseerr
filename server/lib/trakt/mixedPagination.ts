import type {
  TraktListSortBy,
  TraktMediaItem,
} from '@server/api/trakt/interfaces';

export type TraktPaginatedItems = {
  items: TraktMediaItem[];
  hasMore: boolean;
};

export function getTraktItemSortTimestamp(
  item: TraktMediaItem,
  sortBy: TraktListSortBy
): number {
  const value = sortBy === 'added' ? item.traktAddedAt : item.traktReleaseDate;
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function sortTraktItemsBy(
  items: TraktMediaItem[],
  sortBy: TraktListSortBy
): TraktMediaItem[] {
  return [...items].sort(
    (a, b) =>
      getTraktItemSortTimestamp(b, sortBy) -
      getTraktItemSortTimestamp(a, sortBy)
  );
}

export function paginateSortedTraktItems(
  items: TraktMediaItem[],
  options: {
    page: number;
    limit: number;
    sortBy: TraktListSortBy;
    hasMoreUpstream: boolean;
  }
): TraktPaginatedItems {
  const page = Math.max(1, options.page);
  const limit = Math.max(1, options.limit);
  const sorted = sortTraktItemsBy(items, options.sortBy);
  const start = (page - 1) * limit;
  const end = start + limit;

  return {
    items: sorted.slice(start, end),
    hasMore: sorted.length > end || options.hasMoreUpstream,
  };
}

export type MergeAndPaginateOptions = {
  page: number;
  limit: number;
  movieHasMore: boolean;
  tvHasMore: boolean;
  /** Defaults to `traktAddedAt` (listed_at / watched_at). */
  getTimestamp?: (item: TraktMediaItem) => number;
};

function defaultTimestamp(item: TraktMediaItem): number {
  const value = item.traktAddedAt ? Date.parse(item.traktAddedAt) : Number.NaN;
  return Number.isFinite(value) ? value : 0;
}

export function traktItemKey(item: {
  mediaType: 'movie' | 'tv';
  tmdbId?: number;
  traktSlug?: string;
  traktId?: number;
  title?: string;
}): string {
  if (item.tmdbId && item.tmdbId > 0) {
    return `${item.mediaType}:tmdb:${item.tmdbId}`;
  }
  if (item.traktSlug) {
    return `${item.mediaType}:slug:${item.traktSlug}`;
  }
  if (item.traktId && item.traktId > 0) {
    return `${item.mediaType}:trakt:${item.traktId}`;
  }
  return `${item.mediaType}:title:${item.title ?? ''}`;
}

/**
 * Merge movie + TV streams (each already chronological desc), dedupe, then
 * slice the requested page. Callers must supply at least `page * limit` items
 * from each stream (or the exhausted remainder) so page boundaries stay global.
 */
export function mergeAndPaginateTraktItems(
  movieItems: TraktMediaItem[],
  tvItems: TraktMediaItem[],
  options: MergeAndPaginateOptions
): TraktPaginatedItems {
  const page = Math.max(1, options.page);
  const limit = Math.max(1, options.limit);
  const getTimestamp = options.getTimestamp ?? defaultTimestamp;

  const merged: TraktMediaItem[] = [];
  const seen = new Set<string>();
  const pushUnique = (item: TraktMediaItem) => {
    const key = traktItemKey(item);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    merged.push(item);
  };

  let movieIndex = 0;
  let tvIndex = 0;
  while (movieIndex < movieItems.length || tvIndex < tvItems.length) {
    const movie = movieItems[movieIndex];
    const tv = tvItems[tvIndex];
    if (!movie) {
      pushUnique(tv);
      tvIndex++;
      continue;
    }
    if (!tv) {
      pushUnique(movie);
      movieIndex++;
      continue;
    }
    if (getTimestamp(movie) >= getTimestamp(tv)) {
      pushUnique(movie);
      movieIndex++;
    } else {
      pushUnique(tv);
      tvIndex++;
    }
  }

  const start = (page - 1) * limit;
  const end = start + limit;
  const items = merged.slice(start, end);
  const hasMore =
    merged.length > end || options.movieHasMore || options.tvHasMore;

  return { items, hasMore };
}
