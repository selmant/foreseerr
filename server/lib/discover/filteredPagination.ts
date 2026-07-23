import type { User } from '@server/entity/User';
import {
  enrichResultsWithRatings,
  needsMdblistEnrichment,
} from '@server/lib/ratings';
import {
  filterDiscoverResults,
  hasBrowseQueryFilters,
  parseBrowseQueryFilters,
} from '@server/lib/requestFilters';
import { createTraktUserClient } from '@server/lib/trakt';
import {
  filterWatchedMixedBrowseResults,
  loadWatchedIdSets,
} from '@server/lib/trakt/hideWatched';
import logger from '@server/logger';
import type {
  CollectionResult,
  MovieResult,
  PersonResult,
  TvResult,
} from '@server/models/Search';
import type { Request } from 'express';

export const TMDB_DISCOVER_ITEMS_PER_PAGE = 20;
export const MAX_TMDB_UPSTREAM_PAGES = 10;

type BrowseResult = MovieResult | TvResult | PersonResult | CollectionResult;

export type TmdbUpstreamDiscoverPage<T extends BrowseResult> = {
  items: T[];
  totalPages: number;
  totalResults: number;
};

export type DiscoverPagePayload<T extends BrowseResult> = {
  page: number;
  results: T[];
  hasMore?: boolean;
  totalPages?: number;
  totalResults?: number;
};

function parseTruthyQuery(value: unknown): boolean {
  return value === true || value === 'true' || value === '1';
}

export function needsDiscoverPostFilters(
  user: User | undefined,
  query: Request['query']
): boolean {
  if (hasBrowseQueryFilters(parseBrowseQueryFilters(query))) {
    return true;
  }
  return Boolean(user?.id && parseTruthyQuery(query.ignoreWatched));
}

async function filterDiscoverPageResults<T extends BrowseResult>(
  results: T[],
  user: User | undefined,
  query: Request['query']
): Promise<T[]> {
  const working = needsMdblistEnrichment(query)
    ? await enrichResultsWithRatings(results, { query })
    : results;

  let filtered: T[];
  try {
    filtered = await filterDiscoverResults(working, query);
  } catch (e) {
    logger.debug('Skipping Discover result filtering', {
      label: 'API',
      errorMessage: e instanceof Error ? e.message : 'unknown error',
    });
    filtered = working;
  }

  if (!user?.id || !parseTruthyQuery(query.ignoreWatched)) {
    return filtered;
  }

  try {
    const trakt = await createTraktUserClient(user.id);
    const watchedSets = await loadWatchedIdSets(user.id, trakt);
    return filterWatchedMixedBrowseResults(filtered, watchedSets);
  } catch (e) {
    logger.debug('Skipping watched-title filtering', {
      label: 'API',
      errorMessage: e instanceof Error ? e.message : 'unknown error',
    });
    return filtered;
  }
}

/** Post-fetch browse filters for routes that return a single upstream TMDB page. */
export async function applyBrowseDiscoverFilters<T extends BrowseResult>(
  results: T[],
  user: User | undefined,
  query: Request['query']
): Promise<T[]> {
  return filterDiscoverPageResults(results, user, query);
}

export async function paginateTmdbDiscover<T extends BrowseResult>(options: {
  page: number;
  itemsPerPage?: number;
  user?: User;
  query: Request['query'];
  fetchMappedPage: (
    upstreamPage: number
  ) => Promise<TmdbUpstreamDiscoverPage<T>>;
}): Promise<DiscoverPagePayload<T>> {
  const requestedPage = Math.max(1, options.page);
  const itemsPerPage = Math.max(
    1,
    options.itemsPerPage ?? TMDB_DISCOVER_ITEMS_PER_PAGE
  );
  const { user, query, fetchMappedPage } = options;

  if (!needsDiscoverPostFilters(user, query)) {
    const upstream = await fetchMappedPage(requestedPage);
    return {
      page: requestedPage,
      totalPages: upstream.totalPages,
      totalResults: upstream.totalResults,
      results: await enrichResultsWithRatings(upstream.items, { query }),
    };
  }

  const needed = requestedPage * itemsPerPage;
  const filtered: T[] = [];
  let upstreamPage = 1;
  let upstreamHasMore = false;

  while (upstreamPage <= MAX_TMDB_UPSTREAM_PAGES) {
    const upstream = await fetchMappedPage(upstreamPage);
    if (!upstream.items.length) {
      upstreamHasMore = false;
      break;
    }

    upstreamHasMore = upstreamPage < upstream.totalPages;
    filtered.push(
      ...(await filterDiscoverPageResults(upstream.items, user, query))
    );

    if (!upstreamHasMore) {
      break;
    }
    if (filtered.length >= needed) {
      break;
    }
    upstreamPage++;
  }

  const start = (requestedPage - 1) * itemsPerPage;
  const pageItems = filtered.slice(start, start + itemsPerPage);
  const hasMore =
    filtered.length > start + itemsPerPage ||
    (upstreamHasMore && upstreamPage < MAX_TMDB_UPSTREAM_PAGES);

  return {
    page: requestedPage,
    hasMore,
    results: await enrichResultsWithRatings(pageItems, {
      query,
      skipExisting: true,
    }),
  };
}
