import type TheMovieDb from '@server/api/themoviedb';
import type {
  TraktListSortBy,
  TraktMediaItem,
} from '@server/api/trakt/interfaces';
import type { User } from '@server/entity/User';
import {
  filterTraktDiscoverItems,
  hasBrowseQueryFilters,
  parseBrowseQueryFilters,
} from '@server/lib/requestFilters';
import {
  filterWatchedTraktItems,
  loadCombinedWatchedIdSets,
} from '@server/lib/trakt/hideWatched';
import { paginateSortedTraktItems } from '@server/lib/trakt/mixedPagination';
import type { Request } from 'express';

export const MAX_TRAKT_DISCOVER_UPSTREAM_PAGES = 10;

function parseTruthyQuery(value: unknown): boolean {
  return value === true || value === 'true' || value === '1';
}

export function needsTraktDiscoverPostFilters(
  user: User | undefined,
  query?: Request['query'],
  skipWatchedFilter = false
): boolean {
  if (hasBrowseQueryFilters(parseBrowseQueryFilters(query ?? {}))) {
    return true;
  }
  return Boolean(
    !skipWatchedFilter && user?.id && parseTruthyQuery(query?.ignoreWatched)
  );
}

export async function filterTraktDiscoverPageItems(
  items: TraktMediaItem[],
  options: {
    user?: User;
    query?: Request['query'];
    tmdb: TheMovieDb;
    skipWatchedFilter?: boolean;
  }
): Promise<TraktMediaItem[]> {
  let filtered = await filterTraktDiscoverItems(
    items,
    options.tmdb,
    options.query ?? {}
  );

  if (
    !options.skipWatchedFilter &&
    options.user?.id &&
    parseTruthyQuery(options.query?.ignoreWatched)
  ) {
    const watchedSets = await loadCombinedWatchedIdSets(options.user.id);
    filtered = filterWatchedTraktItems(filtered, watchedSets);
  }

  return filtered;
}

export async function fetchPaginatedTraktDiscoverWithPostFilters(
  fetchUpstreamPage: (
    upstreamPage: number
  ) => Promise<{ items: TraktMediaItem[]; hasMore: boolean }>,
  options: {
    page: number;
    itemsPerPage: number;
    user?: User;
    query?: Request['query'];
    tmdb: TheMovieDb;
    skipWatchedFilter?: boolean;
    sortBy?: TraktListSortBy;
  }
): Promise<{ items: TraktMediaItem[]; hasMore: boolean }> {
  const requestedPage = Math.max(1, options.page);
  const itemsPerPage = Math.max(1, options.itemsPerPage);
  const needed = requestedPage * itemsPerPage;
  const filtered: TraktMediaItem[] = [];
  let upstreamPage = 1;
  let upstreamHasMore = false;

  while (upstreamPage <= MAX_TRAKT_DISCOVER_UPSTREAM_PAGES) {
    const upstream = await fetchUpstreamPage(upstreamPage);
    if (!upstream.items.length) {
      upstreamHasMore = false;
      break;
    }

    upstreamHasMore = upstream.hasMore;
    filtered.push(
      ...(await filterTraktDiscoverPageItems(upstream.items, options))
    );

    if (!upstreamHasMore) {
      break;
    }
    if (!options.sortBy && filtered.length >= needed) {
      break;
    }
    upstreamPage++;
  }

  if (options.sortBy) {
    return paginateSortedTraktItems(filtered, {
      page: requestedPage,
      limit: itemsPerPage,
      sortBy: options.sortBy,
      hasMoreUpstream:
        upstreamHasMore && upstreamPage < MAX_TRAKT_DISCOVER_UPSTREAM_PAGES,
    });
  }

  const start = (requestedPage - 1) * itemsPerPage;
  const items = filtered.slice(start, start + itemsPerPage);
  const hasMore =
    filtered.length > start + itemsPerPage ||
    (upstreamHasMore && upstreamPage < MAX_TRAKT_DISCOVER_UPSTREAM_PAGES);

  return { items, hasMore };
}
