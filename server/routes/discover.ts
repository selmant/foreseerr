import PlexTvAPI from '@server/api/plextv';
import type { SortOptions } from '@server/api/themoviedb';
import TheMovieDb from '@server/api/themoviedb';
import type { TmdbKeyword } from '@server/api/themoviedb/interfaces';
import TraktAPI, { TraktReconnectRequiredError } from '@server/api/trakt';
import type {
  TraktBrowseMediaType,
  TraktFetchMediaType,
  TraktListSortBy,
  TraktMediaItem,
} from '@server/api/trakt/interfaces';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { Watchlist } from '@server/entity/Watchlist';
import type {
  GenreSliderItem,
  WatchlistItem,
  WatchlistResponse,
} from '@server/interfaces/api/discoverInterfaces';
import {
  applyDiscoverFilterDefaultsToQuery,
  safeParseDiscoverFilterDefaults,
} from '@server/lib/discover/filterDefaults';
import { paginateTmdbDiscover } from '@server/lib/discover/filteredPagination';
import {
  fetchPaginatedTraktDiscoverWithPostFilters,
  filterTraktDiscoverPageItems,
  needsTraktDiscoverPostFilters,
} from '@server/lib/discover/traktDiscoverPagination';
import { enrichResultsWithRatings } from '@server/lib/ratings';
import { traktExtendedForBrowseQuery } from '@server/lib/requestFilters';
import { getSettings } from '@server/lib/settings';
import {
  TraktNotConfiguredError,
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
  TRAKT_RECOMMENDATIONS_ITEMS_PER_PAGE,
  getTraktRecommendationPage,
} from '@server/lib/trakt/recommendations';
import logger from '@server/logger';
import { mapProductionCompany } from '@server/models/Movie';
import {
  mapCollectionResult,
  mapMovieResult,
  mapPersonResult,
  mapTvResult,
} from '@server/models/Search';
import { mapNetwork } from '@server/models/Tv';
import { isCollection, isMovie, isPerson } from '@server/utils/typeHelpers';
import type { Request } from 'express';
import { Router } from 'express';
import { sortBy } from 'lodash';
import { z } from 'zod';

const mapTraktItems = (items: TraktMediaItem[]): WatchlistItem[] =>
  items.map((item) => ({
    id: item.tmdbId,
    ratingKey: `trakt-${item.mediaType}-${item.tmdbId}`,
    tmdbId: item.tmdbId,
    mediaType: item.mediaType,
    title: item.title,
  }));

interface MapFilteredTraktItemsOptions {
  user?: User;
  query?: Request['query'];
  tmdb?: TheMovieDb;
  skipWatchedFilter?: boolean;
  skipPostFilters?: boolean;
}

const mapFilteredTraktItems = async (
  items: TraktMediaItem[],
  options: MapFilteredTraktItemsOptions = {}
): Promise<WatchlistItem[]> => {
  const tmdb = options.tmdb ?? new TheMovieDb();
  const filtered = options.skipPostFilters
    ? items
    : await filterTraktDiscoverPageItems(items, {
        user: options.user,
        query: options.query,
        tmdb,
        skipWatchedFilter: options.skipWatchedFilter,
      });

  return enrichResultsWithRatings(mapTraktItems(filtered), {
    query: options.query,
    skipExisting: true,
  });
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

const handleTraktRouteError = (
  e: unknown,
  next: (err?: unknown) => void,
  fallbackMessage: string
) => {
  if (e instanceof TraktNotConfiguredError) {
    return next({ status: 400, message: e.message });
  }
  if (e instanceof TraktNotLinkedError) {
    return next({ status: 404, message: e.message });
  }
  if (e instanceof TraktReconnectRequiredError) {
    return next({ status: 401, message: e.message });
  }
  logger.error(fallbackMessage, {
    label: 'API',
    errorMessage: e instanceof Error ? e.message : 'unknown error',
  });
  return next({ status: 500, message: fallbackMessage });
};

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

function parseTraktTruthyQuery(value: unknown): boolean {
  // OpenAPI boolean query params arrive as real booleans after validation.
  return value === true || value === 'true' || value === '1';
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

export const createTmdbWithRegionLanguage = (user?: User): TheMovieDb => {
  const settings = getSettings();

  const discoverRegion =
    user?.settings?.streamingRegion === 'all'
      ? ''
      : user?.settings?.streamingRegion
        ? user?.settings?.streamingRegion
        : settings.main.discoverRegion;

  const originalLanguage =
    user?.settings?.originalLanguage === 'all'
      ? ''
      : user?.settings?.originalLanguage
        ? user?.settings?.originalLanguage
        : settings.main.originalLanguage;

  return new TheMovieDb({
    discoverRegion,
    originalLanguage,
  });
};

export const createTmdbWithBlocklistSettings = (): TheMovieDb => {
  const settings = getSettings();

  return new TheMovieDb({
    discoverRegion: settings.main.blocklistRegion,
    originalLanguage: settings.main.blocklistLanguage,
  });
};

const discoverRoutes = Router();

/** Apply per-user Discover filter defaults when query keys are omitted. */
discoverRoutes.use((req, _res, next) => {
  if (parseTraktTruthyQuery(req.query.ignoreDiscoverDefaults)) {
    return next();
  }
  req.query = applyDiscoverFilterDefaultsToQuery(
    req.query,
    safeParseDiscoverFilterDefaults(req.user?.settings?.discoverFilterDefaults)
  );
  next();
});

const QueryFilterOptions = z.object({
  page: z.coerce.string().optional(),
  sortBy: z.coerce.string().optional(),
  primaryReleaseDateGte: z.coerce.string().optional(),
  primaryReleaseDateLte: z.coerce.string().optional(),
  firstAirDateGte: z.coerce.string().optional(),
  firstAirDateLte: z.coerce.string().optional(),
  studio: z.coerce.string().optional(),
  genre: z.coerce.string().optional(),
  keywords: z.coerce.string().optional(),
  excludeKeywords: z.coerce.string().optional(),
  language: z.coerce.string().optional(),
  withRuntimeGte: z.coerce.string().optional(),
  withRuntimeLte: z.coerce.string().optional(),
  voteAverageGte: z.coerce.string().optional(),
  voteAverageLte: z.coerce.string().optional(),
  voteCountGte: z.coerce.string().optional(),
  voteCountLte: z.coerce.string().optional(),
  network: z.coerce.string().optional(),
  watchProviders: z.coerce.string().optional(),
  watchRegion: z.coerce.string().optional(),
  status: z.coerce.string().optional(),
  certification: z.coerce.string().optional(),
  certificationGte: z.coerce.string().optional(),
  certificationLte: z.coerce.string().optional(),
  certificationCountry: z.coerce.string().optional(),
  certificationMode: z.enum(['exact', 'range']).optional(),
});

export type FilterOptions = z.infer<typeof QueryFilterOptions>;
const ApiQuerySchema = QueryFilterOptions.omit({
  certificationMode: true,
});

discoverRoutes.get('/movies', async (req, res, next) => {
  const tmdb = createTmdbWithRegionLanguage(req.user);

  try {
    const query = ApiQuerySchema.parse(req.query);
    const keywords = query.keywords;
    const excludeKeywords = query.excludeKeywords;

    let keywordData: TmdbKeyword[] = [];
    if (keywords) {
      const splitKeywords = keywords.split(',');

      const keywordResults = await Promise.all(
        splitKeywords.map(async (keywordId) => {
          return await tmdb.getKeywordDetails({ keywordId: Number(keywordId) });
        })
      );

      keywordData = keywordResults.filter(
        (keyword): keyword is TmdbKeyword => keyword !== null
      );
    }

    const page = Number(query.page) || 1;
    const paginated = await paginateTmdbDiscover({
      page,
      user: req.user,
      query: req.query,
      fetchMappedPage: async (upstreamPage) => {
        const data = await tmdb.getDiscoverMovies({
          page: upstreamPage,
          sortBy: query.sortBy as SortOptions,
          language: req.locale ?? query.language,
          originalLanguage: query.language,
          genre: query.genre,
          studio: query.studio,
          primaryReleaseDateLte: query.primaryReleaseDateLte
            ? new Date(query.primaryReleaseDateLte).toISOString().split('T')[0]
            : undefined,
          primaryReleaseDateGte: query.primaryReleaseDateGte
            ? new Date(query.primaryReleaseDateGte).toISOString().split('T')[0]
            : undefined,
          keywords,
          excludeKeywords,
          withRuntimeGte: query.withRuntimeGte,
          withRuntimeLte: query.withRuntimeLte,
          voteAverageGte: query.voteAverageGte,
          voteAverageLte: query.voteAverageLte,
          voteCountGte: query.voteCountGte,
          voteCountLte: query.voteCountLte,
          watchProviders: query.watchProviders,
          watchRegion: query.watchRegion,
          certification: query.certification,
          certificationGte: query.certificationGte,
          certificationLte: query.certificationLte,
          certificationCountry: query.certificationCountry,
        });

        const media = await Media.getRelatedMedia(
          req.user,
          data.results.map((result) => ({
            tmdbId: result.id,
            mediaType: MediaType.MOVIE,
          }))
        );

        return {
          items: data.results.map((result) =>
            mapMovieResult(
              result,
              media.find(
                (req) =>
                  req.tmdbId === result.id && req.mediaType === MediaType.MOVIE
              )
            )
          ),
          totalPages: data.total_pages,
          totalResults: data.total_results,
        };
      },
    });

    return res.status(200).json({
      ...paginated,
      keywords: keywordData,
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving popular movies', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve popular movies.',
    });
  }
});

discoverRoutes.get<{ language: string }>(
  '/movies/language/:language',
  async (req, res, next) => {
    const tmdb = createTmdbWithRegionLanguage(req.user);

    try {
      const languages = await tmdb.getLanguages();

      const language = languages.find(
        (lang) => lang.iso_639_1 === req.params.language
      );

      if (!language) {
        return next({ status: 404, message: 'Language not found.' });
      }

      const page = Number(req.query.page) || 1;
      const paginated = await paginateTmdbDiscover({
        page,
        user: req.user,
        query: req.query,
        fetchMappedPage: async (upstreamPage) => {
          const data = await tmdb.getDiscoverMovies({
            page: upstreamPage,
            language: (req.query.language as string) ?? req.locale,
            originalLanguage: req.params.language,
          });

          const media = await Media.getRelatedMedia(
            req.user,
            data.results.map((result) => ({
              tmdbId: result.id,
              mediaType: MediaType.MOVIE,
            }))
          );

          return {
            items: data.results.map((result) =>
              mapMovieResult(
                result,
                media.find(
                  (req) =>
                    req.tmdbId === result.id &&
                    req.mediaType === MediaType.MOVIE
                )
              )
            ),
            totalPages: data.total_pages,
            totalResults: data.total_results,
          };
        },
      });

      return res.status(200).json({
        ...paginated,
        language,
      });
    } catch (e) {
      logger.debug('Something went wrong retrieving movies by language', {
        label: 'API',
        errorMessage: e.message,
        language: req.params.language,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve movies by language.',
      });
    }
  }
);

discoverRoutes.get<{ genreId: string }>(
  '/movies/genre/:genreId',
  async (req, res, next) => {
    const tmdb = createTmdbWithRegionLanguage(req.user);

    try {
      const genres = await tmdb.getMovieGenres({
        language: (req.query.language as string) ?? req.locale,
      });

      const genre = genres.find(
        (genre) => genre.id === Number(req.params.genreId)
      );

      if (!genre) {
        return next({ status: 404, message: 'Genre not found.' });
      }

      const page = Number(req.query.page) || 1;
      const paginated = await paginateTmdbDiscover({
        page,
        user: req.user,
        query: req.query,
        fetchMappedPage: async (upstreamPage) => {
          const data = await tmdb.getDiscoverMovies({
            page: upstreamPage,
            language: (req.query.language as string) ?? req.locale,
            genre: req.params.genreId as string,
          });

          const media = await Media.getRelatedMedia(
            req.user,
            data.results.map((result) => ({
              tmdbId: result.id,
              mediaType: MediaType.MOVIE,
            }))
          );

          return {
            items: data.results.map((result) =>
              mapMovieResult(
                result,
                media.find(
                  (req) =>
                    req.tmdbId === result.id &&
                    req.mediaType === MediaType.MOVIE
                )
              )
            ),
            totalPages: data.total_pages,
            totalResults: data.total_results,
          };
        },
      });

      return res.status(200).json({
        ...paginated,
        genre,
      });
    } catch (e) {
      logger.debug('Something went wrong retrieving movies by genre', {
        label: 'API',
        errorMessage: e.message,
        genreId: req.params.genreId,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve movies by genre.',
      });
    }
  }
);

discoverRoutes.get<{ studioId: string }>(
  '/movies/studio/:studioId',
  async (req, res, next) => {
    const tmdb = new TheMovieDb();

    try {
      const studio = await tmdb.getStudio(Number(req.params.studioId));

      const page = Number(req.query.page) || 1;
      const paginated = await paginateTmdbDiscover({
        page,
        user: req.user,
        query: req.query,
        fetchMappedPage: async (upstreamPage) => {
          const data = await tmdb.getDiscoverMovies({
            page: upstreamPage,
            language: (req.query.language as string) ?? req.locale,
            studio: req.params.studioId as string,
          });

          const media = await Media.getRelatedMedia(
            req.user,
            data.results.map((result) => ({
              tmdbId: result.id,
              mediaType: MediaType.MOVIE,
            }))
          );

          return {
            items: data.results.map((result) =>
              mapMovieResult(
                result,
                media.find(
                  (med) =>
                    med.tmdbId === result.id &&
                    med.mediaType === MediaType.MOVIE
                )
              )
            ),
            totalPages: data.total_pages,
            totalResults: data.total_results,
          };
        },
      });

      return res.status(200).json({
        ...paginated,
        studio: mapProductionCompany(studio),
      });
    } catch (e) {
      logger.debug('Something went wrong retrieving movies by studio', {
        label: 'API',
        errorMessage: e.message,
        studioId: req.params.studioId,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve movies by studio.',
      });
    }
  }
);

discoverRoutes.get('/movies/upcoming', async (req, res, next) => {
  const tmdb = createTmdbWithRegionLanguage(req.user);

  const now = new Date();
  const offset = now.getTimezoneOffset();
  const date = new Date(now.getTime() - offset * 60 * 1000)
    .toISOString()
    .split('T')[0];

  try {
    const page = Number(req.query.page) || 1;
    const paginated = await paginateTmdbDiscover({
      page,
      user: req.user,
      query: req.query,
      fetchMappedPage: async (upstreamPage) => {
        const data = await tmdb.getDiscoverMovies({
          page: upstreamPage,
          language: (req.query.language as string) ?? req.locale,
          primaryReleaseDateGte: date,
        });

        const media = await Media.getRelatedMedia(
          req.user,
          data.results.map((result) => ({
            tmdbId: result.id,
            mediaType: MediaType.MOVIE,
          }))
        );

        return {
          items: data.results.map((result) =>
            mapMovieResult(
              result,
              media.find(
                (med) =>
                  med.tmdbId === result.id && med.mediaType === MediaType.MOVIE
              )
            )
          ),
          totalPages: data.total_pages,
          totalResults: data.total_results,
        };
      },
    });

    return res.status(200).json(paginated);
  } catch (e) {
    logger.debug('Something went wrong retrieving upcoming movies', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve upcoming movies.',
    });
  }
});

discoverRoutes.get('/tv', async (req, res, next) => {
  const tmdb = createTmdbWithRegionLanguage(req.user);

  try {
    const query = ApiQuerySchema.parse(req.query);
    const keywords = query.keywords;
    const excludeKeywords = query.excludeKeywords;
    let keywordData: TmdbKeyword[] = [];
    if (keywords) {
      const splitKeywords = keywords.split(',');

      const keywordResults = await Promise.all(
        splitKeywords.map(async (keywordId) => {
          return await tmdb.getKeywordDetails({ keywordId: Number(keywordId) });
        })
      );

      keywordData = keywordResults.filter(
        (keyword): keyword is TmdbKeyword => keyword !== null
      );
    }

    const page = Number(query.page) || 1;
    const paginated = await paginateTmdbDiscover({
      page,
      user: req.user,
      query: req.query,
      fetchMappedPage: async (upstreamPage) => {
        const data = await tmdb.getDiscoverTv({
          page: upstreamPage,
          sortBy: query.sortBy as SortOptions,
          language: req.locale ?? query.language,
          genre: query.genre,
          network: query.network ? Number(query.network) : undefined,
          firstAirDateLte: query.firstAirDateLte
            ? new Date(query.firstAirDateLte).toISOString().split('T')[0]
            : undefined,
          firstAirDateGte: query.firstAirDateGte
            ? new Date(query.firstAirDateGte).toISOString().split('T')[0]
            : undefined,
          originalLanguage: query.language,
          keywords,
          excludeKeywords,
          withRuntimeGte: query.withRuntimeGte,
          withRuntimeLte: query.withRuntimeLte,
          voteAverageGte: query.voteAverageGte,
          voteAverageLte: query.voteAverageLte,
          voteCountGte: query.voteCountGte,
          voteCountLte: query.voteCountLte,
          watchProviders: query.watchProviders,
          watchRegion: query.watchRegion,
          withStatus: query.status,
          certification: query.certification,
          certificationGte: query.certificationGte,
          certificationLte: query.certificationLte,
          certificationCountry: query.certificationCountry,
        });

        const media = await Media.getRelatedMedia(
          req.user,
          data.results.map((result) => ({
            tmdbId: result.id,
            mediaType: MediaType.TV,
          }))
        );

        return {
          items: data.results.map((result) =>
            mapTvResult(
              result,
              media.find(
                (med) =>
                  med.tmdbId === result.id && med.mediaType === MediaType.TV
              )
            )
          ),
          totalPages: data.total_pages,
          totalResults: data.total_results,
        };
      },
    });

    return res.status(200).json({
      ...paginated,
      keywords: keywordData,
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving popular series', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve popular series.',
    });
  }
});

discoverRoutes.get<{ language: string }>(
  '/tv/language/:language',
  async (req, res, next) => {
    const tmdb = createTmdbWithRegionLanguage(req.user);

    try {
      const languages = await tmdb.getLanguages();

      const language = languages.find(
        (lang) => lang.iso_639_1 === req.params.language
      );

      if (!language) {
        return next({ status: 404, message: 'Language not found.' });
      }

      const page = Number(req.query.page) || 1;
      const paginated = await paginateTmdbDiscover({
        page,
        user: req.user,
        query: req.query,
        fetchMappedPage: async (upstreamPage) => {
          const data = await tmdb.getDiscoverTv({
            page: upstreamPage,
            language: (req.query.language as string) ?? req.locale,
            originalLanguage: req.params.language,
          });

          const media = await Media.getRelatedMedia(
            req.user,
            data.results.map((result) => ({
              tmdbId: result.id,
              mediaType: MediaType.TV,
            }))
          );

          return {
            items: data.results.map((result) =>
              mapTvResult(
                result,
                media.find(
                  (med) =>
                    med.tmdbId === result.id && med.mediaType === MediaType.TV
                )
              )
            ),
            totalPages: data.total_pages,
            totalResults: data.total_results,
          };
        },
      });

      return res.status(200).json({
        ...paginated,
        language,
      });
    } catch (e) {
      logger.debug('Something went wrong retrieving series by language', {
        label: 'API',
        errorMessage: e.message,
        language: req.params.language,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve series by language.',
      });
    }
  }
);

discoverRoutes.get<{ genreId: string }>(
  '/tv/genre/:genreId',
  async (req, res, next) => {
    const tmdb = createTmdbWithRegionLanguage(req.user);

    try {
      const genres = await tmdb.getTvGenres({
        language: (req.query.language as string) ?? req.locale,
      });

      const genre = genres.find(
        (genre) => genre.id === Number(req.params.genreId)
      );

      if (!genre) {
        return next({ status: 404, message: 'Genre not found.' });
      }

      const page = Number(req.query.page) || 1;
      const paginated = await paginateTmdbDiscover({
        page,
        user: req.user,
        query: req.query,
        fetchMappedPage: async (upstreamPage) => {
          const data = await tmdb.getDiscoverTv({
            page: upstreamPage,
            language: (req.query.language as string) ?? req.locale,
            genre: req.params.genreId,
          });

          const media = await Media.getRelatedMedia(
            req.user,
            data.results.map((result) => ({
              tmdbId: result.id,
              mediaType: MediaType.TV,
            }))
          );

          return {
            items: data.results.map((result) =>
              mapTvResult(
                result,
                media.find(
                  (med) =>
                    med.tmdbId === result.id && med.mediaType === MediaType.TV
                )
              )
            ),
            totalPages: data.total_pages,
            totalResults: data.total_results,
          };
        },
      });

      return res.status(200).json({
        ...paginated,
        genre,
      });
    } catch (e) {
      logger.debug('Something went wrong retrieving series by genre', {
        label: 'API',
        errorMessage: e.message,
        genreId: req.params.genreId,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve series by genre.',
      });
    }
  }
);

discoverRoutes.get<{ networkId: string }>(
  '/tv/network/:networkId',
  async (req, res, next) => {
    const tmdb = new TheMovieDb();

    try {
      const network = await tmdb.getNetwork(Number(req.params.networkId));

      const page = Number(req.query.page) || 1;
      const paginated = await paginateTmdbDiscover({
        page,
        user: req.user,
        query: req.query,
        fetchMappedPage: async (upstreamPage) => {
          const data = await tmdb.getDiscoverTv({
            page: upstreamPage,
            language: (req.query.language as string) ?? req.locale,
            network: Number(req.params.networkId),
          });

          const media = await Media.getRelatedMedia(
            req.user,
            data.results.map((result) => ({
              tmdbId: result.id,
              mediaType: MediaType.TV,
            }))
          );

          return {
            items: data.results.map((result) =>
              mapTvResult(
                result,
                media.find(
                  (med) =>
                    med.tmdbId === result.id && med.mediaType === MediaType.TV
                )
              )
            ),
            totalPages: data.total_pages,
            totalResults: data.total_results,
          };
        },
      });

      return res.status(200).json({
        ...paginated,
        network: mapNetwork(network),
      });
    } catch (e) {
      logger.debug('Something went wrong retrieving series by network', {
        label: 'API',
        errorMessage: e.message,
        networkId: req.params.networkId,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve series by network.',
      });
    }
  }
);

discoverRoutes.get('/tv/upcoming', async (req, res, next) => {
  const tmdb = createTmdbWithRegionLanguage(req.user);

  const now = new Date();
  const offset = now.getTimezoneOffset();
  const date = new Date(now.getTime() - offset * 60 * 1000)
    .toISOString()
    .split('T')[0];

  try {
    const page = Number(req.query.page) || 1;
    const paginated = await paginateTmdbDiscover({
      page,
      user: req.user,
      query: req.query,
      fetchMappedPage: async (upstreamPage) => {
        const data = await tmdb.getDiscoverTv({
          page: upstreamPage,
          language: (req.query.language as string) ?? req.locale,
          firstAirDateGte: date,
        });

        const media = await Media.getRelatedMedia(
          req.user,
          data.results.map((result) => ({
            tmdbId: result.id,
            mediaType: MediaType.TV,
          }))
        );

        return {
          items: data.results.map((result) =>
            mapTvResult(
              result,
              media.find(
                (med) =>
                  med.tmdbId === result.id && med.mediaType === MediaType.TV
              )
            )
          ),
          totalPages: data.total_pages,
          totalResults: data.total_results,
        };
      },
    });

    return res.status(200).json(paginated);
  } catch (e) {
    logger.debug('Something went wrong retrieving upcoming series', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve upcoming series.',
    });
  }
});

discoverRoutes.get('/trending', async (req, res, next) => {
  const tmdb = createTmdbWithRegionLanguage(req.user);

  try {
    const mediaType = (req.query.mediaType as 'all' | 'movie' | 'tv') ?? 'all';
    const timeWindow =
      (req.query.timeWindow as 'day' | 'week') === 'week' ? 'week' : 'day';
    const language = (req.query.language as string) ?? req.locale;
    const requestedPage = Number(req.query.page) || 1;

    const trendingFetchers = {
      movie: async (upstreamPage: number) => ({
        data: await tmdb.getMovieTrending({
          page: upstreamPage,
          language,
          timeWindow,
        }),
        mapper: mapMovieResult,
        type: MediaType.MOVIE,
      }),
      tv: async (upstreamPage: number) => ({
        data: await tmdb.getTvTrending({
          page: upstreamPage,
          language,
          timeWindow,
        }),
        mapper: mapTvResult,
        type: MediaType.TV,
      }),
      all: async (upstreamPage: number) => ({
        data: await tmdb.getAllTrending({
          page: upstreamPage,
          language,
          timeWindow,
        }),
        mapper: (result: any, media?: Media) => {
          if (isMovie(result)) {
            return mapMovieResult(result, media);
          } else if (isPerson(result)) {
            return mapPersonResult(result);
          } else if (isCollection(result)) {
            return mapCollectionResult(result);
          } else {
            return mapTvResult(result, media);
          }
        },
        type: null,
      }),
    } as const;

    const paginated = await paginateTmdbDiscover({
      page: requestedPage,
      user: req.user,
      query: req.query,
      fetchMappedPage: async (upstreamPage) => {
        const { data, mapper, type } =
          await trendingFetchers[mediaType](upstreamPage);

        const media = await Media.getRelatedMedia(
          req.user,
          data.results.map((result) => ({
            tmdbId: result.id,
            mediaType: isMovie(result) ? MediaType.MOVIE : MediaType.TV,
          }))
        );

        return {
          items: data.results.map((result) => {
            const selectedMedia = media.find(
              (med) =>
                med.tmdbId === result.id &&
                (type ? med.mediaType === type : true)
            );

            return mapper(result, selectedMedia);
          }),
          totalPages: data.total_pages,
          totalResults: data.total_results,
        };
      },
    });

    return res.status(200).json(paginated);
  } catch (e) {
    logger.debug('Something went wrong retrieving trending items', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve trending items.',
    });
  }
});

discoverRoutes.get<{ keywordId: string }>(
  '/keyword/:keywordId/movies',
  async (req, res, next) => {
    const tmdb = new TheMovieDb();

    try {
      const page = Number(req.query.page) || 1;
      const paginated = await paginateTmdbDiscover({
        page,
        user: req.user,
        query: req.query,
        fetchMappedPage: async (upstreamPage) => {
          const data = await tmdb.getMoviesByKeyword({
            keywordId: Number(req.params.keywordId),
            page: upstreamPage,
            language: (req.query.language as string) ?? req.locale,
          });

          const media = await Media.getRelatedMedia(
            req.user,
            data.results.map((result) => ({
              tmdbId: result.id,
              mediaType: MediaType.MOVIE,
            }))
          );

          return {
            items: data.results.map((result) =>
              mapMovieResult(
                result,
                media.find(
                  (med) =>
                    med.tmdbId === result.id &&
                    med.mediaType === MediaType.MOVIE
                )
              )
            ),
            totalPages: data.total_pages,
            totalResults: data.total_results,
          };
        },
      });

      return res.status(200).json(paginated);
    } catch (e) {
      logger.debug('Something went wrong retrieving movies by keyword', {
        label: 'API',
        errorMessage: e.message,
        keywordId: req.params.keywordId,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve movies by keyword.',
      });
    }
  }
);

discoverRoutes.get<{ language: string }, GenreSliderItem[]>(
  '/genreslider/movie',
  async (req, res, next) => {
    const tmdb = new TheMovieDb();

    try {
      const mappedGenres: GenreSliderItem[] = [];

      const genres = await tmdb.getMovieGenres({
        language: (req.query.language as string) ?? req.locale,
      });

      await Promise.all(
        genres.map(async (genre) => {
          const genreData = await tmdb.getDiscoverMovies({
            genre: genre.id.toString(),
          });

          mappedGenres.push({
            id: genre.id,
            name: genre.name,
            backdrops: genreData.results
              .filter((title) => !!title.backdrop_path)
              .map((title) => title.backdrop_path) as string[],
          });
        })
      );

      const sortedData = sortBy(mappedGenres, 'name');

      return res.status(200).json(sortedData);
    } catch (e) {
      logger.debug('Something went wrong retrieving the movie genre slider', {
        label: 'API',
        errorMessage: e.message,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve movie genre slider.',
      });
    }
  }
);

discoverRoutes.get<{ language: string }, GenreSliderItem[]>(
  '/genreslider/tv',
  async (req, res, next) => {
    const tmdb = new TheMovieDb();

    try {
      const mappedGenres: GenreSliderItem[] = [];

      const genres = await tmdb.getTvGenres({
        language: (req.query.language as string) ?? req.locale,
      });

      await Promise.all(
        genres.map(async (genre) => {
          const genreData = await tmdb.getDiscoverTv({
            genre: genre.id.toString(),
          });

          mappedGenres.push({
            id: genre.id,
            name: genre.name,
            backdrops: genreData.results
              .filter((title) => !!title.backdrop_path)
              .map((title) => title.backdrop_path) as string[],
          });
        })
      );

      const sortedData = sortBy(mappedGenres, 'name');

      return res.status(200).json(sortedData);
    } catch (e) {
      logger.debug('Something went wrong retrieving the series genre slider', {
        label: 'API',
        errorMessage: e.message,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve series genre slider.',
      });
    }
  }
);

discoverRoutes.get<Record<string, unknown>, WatchlistResponse>(
  '/watchlist',
  async (req, res) => {
    const userRepository = getRepository(User);
    const itemsPerPage = 20;
    const page = req.query.page ? Number(req.query.page) : 1;
    const offset = (page - 1) * itemsPerPage;

    const activeUser = await userRepository.findOne({
      where: { id: req.user?.id },
      select: ['id', 'plexToken'],
    });

    if (activeUser && !activeUser?.plexToken) {
      // Non-Plex users can only see their own watchlist
      const [result, total] = await getRepository(Watchlist).findAndCount({
        where: { requestedBy: { id: activeUser?.id } },
        relations: {
          /*requestedBy: true,media:true*/
        },
        // loadRelationIds: true,
        take: itemsPerPage,
        skip: offset,
      });
      if (total) {
        return res.json({
          page: page,
          totalPages: Math.ceil(total / itemsPerPage),
          totalResults: total,
          results: result,
        });
      }
    }
    if (!activeUser?.plexToken) {
      // We will just return an empty array if the user has no Plex token
      return res.json({
        page: 1,
        totalPages: 1,
        totalResults: 0,
        results: [],
      });
    }

    // List watchlist from Plex
    const plexTV = new PlexTvAPI(activeUser.plexToken);

    const watchlist = await plexTV.getWatchlist({ offset });

    const results = await enrichResultsWithRatings(
      watchlist.items.map((item) => ({
        id: item.tmdbId,
        ratingKey: item.ratingKey,
        title: item.title,
        mediaType: item.type === 'show' ? ('tv' as const) : ('movie' as const),
        tmdbId: item.tmdbId,
      }))
    );

    return res.json({
      page,
      totalPages: Math.ceil(watchlist.totalSize / itemsPerPage),
      totalResults: watchlist.totalSize,
      results,
    });
  }
);

discoverRoutes.get('/trakt/recommendations', async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return next({ status: 401, message: 'Unauthorized' });
    }

    const page = req.query.page ? Number(req.query.page) : 1;
    const mediaType = parseTraktMediaTypeQuery(req.query.type);
    const ignoreCollected = parseTraktTruthyQuery(req.query.ignoreCollected);
    const ignoreWatchlisted = parseTraktTruthyQuery(
      req.query.ignoreWatchlisted
    );
    const ignoreWatched = parseTraktTruthyQuery(req.query.ignoreWatched);
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
    return handleTraktRouteError(
      e,
      next,
      'Unable to retrieve Trakt recommendations.'
    );
  }
});

discoverRoutes.get('/trakt/watchlist', async (req, res, next) => {
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
    return handleTraktRouteError(
      e,
      next,
      'Unable to retrieve Trakt watchlist.'
    );
  }
});

discoverRoutes.get('/trakt/history', async (req, res, next) => {
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
    return handleTraktRouteError(e, next, 'Unable to retrieve Trakt history.');
  }
});

discoverRoutes.get('/trakt/lists', async (req, res, next) => {
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
    return handleTraktRouteError(e, next, 'Unable to retrieve Trakt lists.');
  }
});

discoverRoutes.get('/trakt/lists/search', async (req, res, next) => {
  try {
    const query = String(req.query.query ?? '').trim();
    if (!query) {
      return res.status(200).json({ results: [] });
    }

    const trakt = createTraktAppClient();
    const results = await trakt.searchLists(query);
    return res.status(200).json({ results });
  } catch (e) {
    return handleTraktRouteError(e, next, 'Unable to search Trakt lists.');
  }
});

discoverRoutes.get('/trakt/list', async (req, res, next) => {
  try {
    const page = req.query.page ? Number(req.query.page) : 1;
    const mediaType = parseTraktMediaTypeQuery(req.query.type);
    const itemsPerPage = 20;
    const url = String(req.query.url ?? '').trim();
    if (!url) {
      return next({ status: 400, message: 'url query parameter is required' });
    }

    const { username, listRef } = parseTraktListUrlOrThrow(url);
    let trakt: TraktAPI;
    try {
      trakt = req.user?.id
        ? await createTraktUserClient(req.user.id)
        : createTraktAppClient();
    } catch (e) {
      if (e instanceof TraktNotLinkedError) {
        trakt = createTraktAppClient();
      } else {
        throw e;
      }
    }

    let metadataName = listRef;
    const tmdb = createTmdbWithRegionLanguage(req.user);
    const traktFetchType = toTraktFetchMediaType(mediaType);
    const listSort = parseTraktListSortQuery(req.query.sort);
    const extended = listSort ? 'full' : traktExtendedForBrowseQuery(req.query);

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
      } catch {
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
              sortBy: listSort,
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
    return handleTraktRouteError(
      e,
      next,
      'Unable to retrieve Trakt public list.'
    );
  }
});

export default discoverRoutes;
