import TheMovieDb from '@server/api/themoviedb';
import TraktAPI, { TraktRateLimitedError } from '@server/api/trakt';
import type {
  TraktBrowseMediaType,
  TraktFetchMediaType,
  TraktListSortBy,
  TraktMediaItem,
} from '@server/api/trakt/interfaces';
import type { User } from '@server/entity/User';
import type {
  WatchlistItem,
  WatchlistResponse,
} from '@server/interfaces/api/discoverInterfaces';
import { parseDiscoverTruthyQuery } from '@server/lib/discover/filterOptions';
import { handleTraktDiscoverRouteError } from '@server/lib/discover/providerErrors';
import { createTmdbWithRegionLanguage } from '@server/lib/discover/tmdb';
import {
  fetchPaginatedTraktDiscoverWithPostFilters,
  filterTraktDiscoverPageItems,
  needsTraktDiscoverPostFilters,
} from '@server/lib/discover/traktDiscoverPagination';
import {
  hasDiscoverTmdbId,
  omitUnmappedDiscoverItems,
  recordUnmappedItems,
  shouldHideUnmappedFromQuery,
  traktSourceUrl,
} from '@server/lib/discover/unmapped';
import { enrichResultsWithRatings } from '@server/lib/ratings';
import { traktExtendedForBrowseQuery } from '@server/lib/requestFilters';
import {
  TraktNotLinkedError,
  createTraktAppClient,
  createTraktUserClient,
} from '@server/lib/trakt';
import {
  excludeTraktAnimeItems,
  fetchPaginatedTraktAnimeItems,
  fetchPaginatedTraktNonAnimeItems,
  filterTraktAnimeItems,
} from '@server/lib/trakt/animeFilter';
import {
  confirmTraktTmdbIds,
  hydrateTraktTmdbIds,
} from '@server/lib/trakt/mapping';
import {
  TRAKT_RECOMMENDATIONS_ITEMS_PER_PAGE,
  getTraktRecommendationPage,
} from '@server/lib/trakt/recommendations';
import type { Request } from 'express';
import { Router } from 'express';

const traktDiscoverRoutes = Router();

const mapTraktItems = (items: TraktMediaItem[]): WatchlistItem[] =>
  items.map((item) => {
    const sourceId =
      item.traktSlug ||
      (item.traktId ? String(item.traktId) : undefined) ||
      (hasDiscoverTmdbId(item.tmdbId) ? String(item.tmdbId) : item.title);
    const permalink = item.traktSlug || item.traktId;
    return {
      id: item.tmdbId ?? item.traktId ?? 0,
      ratingKey: `trakt-${item.mediaType}-${sourceId}`,
      ...(hasDiscoverTmdbId(item.tmdbId) ? { tmdbId: item.tmdbId } : {}),
      mediaType: item.mediaType,
      title: item.title,
      source: 'trakt' as const,
      sourceId,
      ...(permalink
        ? { sourceUrl: traktSourceUrl(item.mediaType, permalink) }
        : {}),
      mappingState: {
        state: hasDiscoverTmdbId(item.tmdbId)
          ? ('mapped' as const)
          : ('unmapped' as const),
        namespace: 'trakt',
        ...(sourceId ? { externalId: sourceId } : {}),
      },
    };
  });

/**
 * The client to talk to Trakt with, preferring the caller's own token.
 *
 * `createTraktAppClient()` is kept as the last resort rather than removed
 * outright, because Trakt's refusal of `client_id`-only traffic is a policy
 * that could be relaxed. When it is refused the error carries that fact, so the
 * caller sees "link your Trakt account" instead of a 500.
 */
const traktClientForRequest = async (req: Request): Promise<TraktAPI> => {
  if (!req.user?.id) return createTraktAppClient();
  try {
    return await createTraktUserClient(req.user.id);
  } catch (e) {
    if (e instanceof TraktNotLinkedError) return createTraktAppClient();
    throw e;
  }
};

interface MapFilteredTraktItemsOptions {
  user?: User;
  query?: Request['query'];
  tmdb?: TheMovieDb;
  skipWatchedFilter?: boolean;
  skipPostFilters?: boolean;
  discoverSource?: string;
}

const mapFilteredTraktItems = async (
  items: TraktMediaItem[],
  options: MapFilteredTraktItemsOptions = {}
): Promise<WatchlistItem[]> => {
  const tmdb = options.tmdb ?? new TheMovieDb();
  // Resolve before filtering: the watched and availability filters key off the
  // TMDB id, so an item resolved afterwards would bypass them.
  const hydrated = await confirmTraktTmdbIds(
    await hydrateTraktTmdbIds(items, {
      discoverSource: options.discoverSource ?? 'trakt',
    }),
    { discoverSource: options.discoverSource ?? 'trakt' }
  );
  const filtered = options.skipPostFilters
    ? hydrated
    : await filterTraktDiscoverPageItems(hydrated, {
        user: options.user,
        query: options.query,
        tmdb,
        skipWatchedFilter: options.skipWatchedFilter,
      });

  const mapped = await enrichResultsWithRatings(mapTraktItems(filtered), {
    query: options.query,
    skipExisting: true,
  });
  recordUnmappedItems(mapped, {
    namespace: 'trakt',
    discoverSource: options.discoverSource ?? 'trakt',
  });

  return omitUnmappedDiscoverItems(
    mapped,
    shouldHideUnmappedFromQuery(options.query ?? {})
  );
};

async function resolveTraktDiscoverPage(options: {
  page: number;
  itemsPerPage: number;
  mediaType: TraktBrowseMediaType;
  user?: User;
  query?: Request['query'];
  tmdb: TheMovieDb;
  skipWatchedFilter?: boolean;
  listSort?: TraktListSortBy;
  fetchRawPage: (
    traktPage: number
  ) => Promise<{ items: TraktMediaItem[]; hasMore: boolean }>;
}): Promise<{ items: TraktMediaItem[]; hasMore: boolean }> {
  const fetchUpstreamPage = async (traktPage: number) =>
    loadTraktMediaTypeFilteredPage(
      options.mediaType,
      await options.fetchRawPage(traktPage),
      options.tmdb
    );

  if (
    needsTraktDiscoverPostFilters(
      options.user,
      options.query,
      options.skipWatchedFilter
    )
  ) {
    return fetchPaginatedTraktDiscoverWithPostFilters(fetchUpstreamPage, {
      page: options.page,
      itemsPerPage: options.itemsPerPage,
      user: options.user,
      query: options.query,
      tmdb: options.tmdb,
      skipWatchedFilter: options.skipWatchedFilter,
      sortBy: options.listSort,
    });
  }

  if (options.mediaType === 'anime') {
    return fetchPaginatedTraktAnimeItems(
      (traktPage) => traktPageItems(fetchUpstreamPage(traktPage)),
      options.page,
      options.itemsPerPage,
      options.tmdb,
      options.listSort
    );
  }

  if (options.mediaType === 'tv') {
    return fetchPaginatedTraktNonAnimeItems(
      (traktPage) => traktPageItems(fetchUpstreamPage(traktPage)),
      options.page,
      options.itemsPerPage,
      options.tmdb,
      options.listSort
    );
  }

  return fetchUpstreamPage(options.page);
}
function parseTraktMediaTypeQuery(value: unknown): TraktBrowseMediaType {
  if (value === 'movie' || value === 'tv' || value === 'anime') {
    return value;
  }
  return 'all';
}

function parseTraktListSortQuery(value: unknown): TraktListSortBy | undefined {
  if (value === 'added' || value === 'released') {
    return value;
  }
  return undefined;
}

function toTraktFetchMediaType(
  mediaType: TraktBrowseMediaType
): TraktFetchMediaType {
  if (mediaType === 'anime') {
    return 'all';
  }
  return mediaType;
}

/** Adapter for anime/non-anime page fillers that still expect a bare item array. */
async function traktPageItems(
  page: Promise<{ items: TraktMediaItem[]; hasMore: boolean }>
): Promise<TraktMediaItem[]> {
  return (await page).items;
}

async function loadTraktMediaTypeFilteredPage(
  mediaType: TraktBrowseMediaType,
  upstream: { items: TraktMediaItem[]; hasMore: boolean },
  tmdb: TheMovieDb
): Promise<{ items: TraktMediaItem[]; hasMore: boolean }> {
  if (mediaType === 'anime') {
    return {
      items: await filterTraktAnimeItems(upstream.items, tmdb),
      hasMore: upstream.hasMore,
    };
  }
  if (mediaType === 'tv') {
    return {
      items: await excludeTraktAnimeItems(upstream.items, tmdb),
      hasMore: upstream.hasMore,
    };
  }
  return upstream;
}

function parseTraktListUrlOrThrow(url: string): {
  username: string | null;
  listRef: string;
} {
  try {
    return TraktAPI.parseListUrl(url);
  } catch (e) {
    throw {
      status: 400,
      message: e instanceof Error ? e.message : 'Invalid Trakt list URL',
    };
  }
}
traktDiscoverRoutes.get('/recommendations', async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return next({ status: 401, message: 'Unauthorized' });
    }

    const page = req.query.page ? Number(req.query.page) : 1;
    const mediaType = parseTraktMediaTypeQuery(req.query.type);
    const ignoreCollected = parseDiscoverTruthyQuery(req.query.ignoreCollected);
    const ignoreWatchlisted = parseDiscoverTruthyQuery(
      req.query.ignoreWatchlisted
    );
    const ignoreWatched = parseDiscoverTruthyQuery(req.query.ignoreWatched);
    const trakt = await createTraktUserClient(req.user.id);
    const tmdb = createTmdbWithRegionLanguage(req.user);

    const extended = traktExtendedForBrowseQuery(req.query);
    const recommendationPage = await getTraktRecommendationPage(
      req.user.id,
      trakt,
      tmdb,
      {
        mediaType,
        ignoreCollected,
        ignoreWatchlisted,
        ignoreWatched,
        extended,
      },
      page,
      TRAKT_RECOMMENDATIONS_ITEMS_PER_PAGE
    );

    let items = recommendationPage.pageItems;
    let hasMore = recommendationPage.hasMore;
    if (needsTraktDiscoverPostFilters(req.user, req.query, true)) {
      ({ items, hasMore } = await fetchPaginatedTraktDiscoverWithPostFilters(
        async (upstreamPage) => {
          const nextPage = await getTraktRecommendationPage(
            req.user!.id,
            trakt,
            tmdb,
            {
              mediaType,
              ignoreCollected,
              ignoreWatchlisted,
              ignoreWatched,
              extended,
            },
            upstreamPage,
            TRAKT_RECOMMENDATIONS_ITEMS_PER_PAGE
          );
          return {
            items: nextPage.pageItems,
            hasMore: nextPage.hasMore,
          };
        },
        {
          page,
          itemsPerPage: TRAKT_RECOMMENDATIONS_ITEMS_PER_PAGE,
          user: req.user,
          query: req.query,
          tmdb,
          skipWatchedFilter: true,
        }
      ));
    }

    const response: WatchlistResponse = {
      page,
      hasMore,
      results: await mapFilteredTraktItems(items, {
        user: req.user,
        query: req.query,
        tmdb,
        skipWatchedFilter: true,
        skipPostFilters: true,
      }),
    };
    if (recommendationPage.totalPages != null) {
      response.totalPages = recommendationPage.totalPages;
    }
    if (recommendationPage.totalResults != null) {
      response.totalResults = recommendationPage.totalResults;
    }

    return res.status(200).json(response);
  } catch (e) {
    return handleTraktDiscoverRouteError(
      e,
      next,
      'Unable to retrieve Trakt recommendations.'
    );
  }
});

traktDiscoverRoutes.get('/watchlist', async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return next({ status: 401, message: 'Unauthorized' });
    }

    const page = req.query.page ? Number(req.query.page) : 1;
    const mediaType = parseTraktMediaTypeQuery(req.query.type);
    const itemsPerPage = 20;
    const trakt = await createTraktUserClient(req.user.id);
    const tmdb = createTmdbWithRegionLanguage(req.user);
    const traktFetchType = toTraktFetchMediaType(mediaType);
    const extended = traktExtendedForBrowseQuery(req.query);
    const { items, hasMore } = await resolveTraktDiscoverPage({
      page,
      itemsPerPage,
      mediaType,
      user: req.user,
      query: req.query,
      tmdb,
      fetchRawPage: (traktPage) =>
        trakt.getWatchlistItems('me', traktFetchType, {
          page: traktPage,
          limit: itemsPerPage,
          extended,
        }),
    });

    return res.status(200).json({
      page,
      hasMore,
      results: await mapFilteredTraktItems(items, {
        user: req.user,
        query: req.query,
        tmdb,
        skipPostFilters: true,
      }),
    } satisfies WatchlistResponse);
  } catch (e) {
    return handleTraktDiscoverRouteError(
      e,
      next,
      'Unable to retrieve Trakt watchlist.'
    );
  }
});

traktDiscoverRoutes.get('/history', async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return next({ status: 401, message: 'Unauthorized' });
    }

    const page = req.query.page ? Number(req.query.page) : 1;
    const mediaType = parseTraktMediaTypeQuery(req.query.type);
    const itemsPerPage = 20;
    const trakt = await createTraktUserClient(req.user.id);
    const tmdb = createTmdbWithRegionLanguage(req.user);
    const traktFetchType = toTraktFetchMediaType(mediaType);
    const extended = traktExtendedForBrowseQuery(req.query);
    const { items, hasMore } = await resolveTraktDiscoverPage({
      page,
      itemsPerPage,
      mediaType,
      user: req.user,
      query: req.query,
      tmdb,
      skipWatchedFilter: true,
      fetchRawPage: (traktPage) =>
        trakt.getHistoryItems(traktFetchType, {
          page: traktPage,
          limit: itemsPerPage,
          extended,
        }),
    });

    return res.status(200).json({
      page,
      hasMore,
      results: await mapFilteredTraktItems(items, {
        user: req.user,
        query: req.query,
        tmdb,
        skipWatchedFilter: true,
        skipPostFilters: true,
      }),
    } satisfies WatchlistResponse);
  } catch (e) {
    return handleTraktDiscoverRouteError(
      e,
      next,
      'Unable to retrieve Trakt history.'
    );
  }
});

traktDiscoverRoutes.get('/lists', async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return next({ status: 401, message: 'Unauthorized' });
    }

    const trakt = await createTraktUserClient(req.user.id);
    const [lists, likedLists] = await Promise.all([
      trakt.getUserLists('me'),
      trakt.getLikedLists(),
    ]);
    const withWatchlist = [
      {
        id: 'watchlist',
        slug: 'watchlist',
        name: 'Watchlist',
        itemCount: 0,
        isWatchlist: true as const,
      },
      ...lists,
      ...likedLists,
    ];

    return res.status(200).json({ results: withWatchlist });
  } catch (e) {
    return handleTraktDiscoverRouteError(
      e,
      next,
      'Unable to retrieve Trakt lists.'
    );
  }
});

traktDiscoverRoutes.get('/lists/search', async (req, res, next) => {
  try {
    const query = String(req.query.query ?? '').trim();
    if (!query) {
      return res.status(200).json({ results: [] });
    }

    // Prefer the caller's own token: an app-client search is answered with 403
    // by Trakt today, so the user client is the only one that works.
    const trakt = await traktClientForRequest(req);
    const results = await trakt.searchLists(query);
    return res.status(200).json({ results });
  } catch (e) {
    return handleTraktDiscoverRouteError(
      e,
      next,
      'Unable to search Trakt lists.'
    );
  }
});

traktDiscoverRoutes.get('/list', async (req, res, next) => {
  try {
    const page = req.query.page ? Number(req.query.page) : 1;
    const mediaType = parseTraktMediaTypeQuery(req.query.type);
    const itemsPerPage = 20;
    const url = String(req.query.url ?? '').trim();
    if (!url) {
      return next({ status: 400, message: 'url query parameter is required' });
    }

    const { username, listRef } = parseTraktListUrlOrThrow(url);
    const trakt = await traktClientForRequest(req);

    let metadataName = listRef;
    const tmdb = createTmdbWithRegionLanguage(req.user);
    const traktFetchType = toTraktFetchMediaType(mediaType);
    const listSort = parseTraktListSortQuery(req.query.sort);
    const usePostFilters = needsTraktDiscoverPostFilters(
      req.user,
      req.query,
      false
    );
    // Post-filters already collect + sort locally. Passing sortBy into
    // getListItems here would re-fetch up to 10 Trakt pages per upstream page.
    const sortInsideTraktClient = Boolean(listSort) && !usePostFilters;
    const extended =
      listSort || usePostFilters
        ? 'full'
        : traktExtendedForBrowseQuery(req.query);

    if (listRef === 'watchlist' && !username) {
      return next({
        status: 400,
        message: 'Watchlist URL must include a username',
      });
    }

    if (listRef !== 'watchlist') {
      try {
        const metadata = await trakt.getListMetadata(username, listRef);
        metadataName = metadata.name || listRef;
      } catch (e) {
        if (e instanceof TraktRateLimitedError) {
          throw e;
        }
        // Metadata is optional for browsing items
      }
    } else {
      metadataName = `${username}'s Watchlist`;
    }

    const { items, hasMore } = await resolveTraktDiscoverPage({
      page,
      itemsPerPage,
      mediaType,
      user: req.user,
      query: req.query,
      tmdb,
      listSort,
      fetchRawPage: (traktPage) =>
        listRef === 'watchlist'
          ? trakt.getWatchlistItems(username!, traktFetchType, {
              page: traktPage,
              limit: itemsPerPage,
              extended,
            })
          : trakt.getListItems(username, listRef, traktFetchType, {
              page: traktPage,
              limit: itemsPerPage,
              extended,
              sortBy: sortInsideTraktClient ? listSort : undefined,
            }),
    });

    return res.status(200).json({
      page,
      hasMore,
      results: await mapFilteredTraktItems(items, {
        user: req.user,
        query: req.query,
        tmdb,
        skipPostFilters: true,
      }),
      title: metadataName,
    });
  } catch (e) {
    if (
      e &&
      typeof e === 'object' &&
      'status' in e &&
      (e as { status?: number }).status === 400
    ) {
      return next(e);
    }
    return handleTraktDiscoverRouteError(
      e,
      next,
      'Unable to retrieve Trakt public list.'
    );
  }
});

export default traktDiscoverRoutes;
