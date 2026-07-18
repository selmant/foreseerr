import PlexTvAPI from '@server/api/plextv';
import type { SortOptions } from '@server/api/themoviedb';
import TheMovieDb from '@server/api/themoviedb';
import type { TmdbKeyword } from '@server/api/themoviedb/interfaces';
import TraktAPI from '@server/api/trakt';
import type { TraktMediaItem } from '@server/api/trakt/interfaces';
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
import {
  filterDiscoverResults,
  filterTraktDiscoverItems,
  traktExtendedForBrowseQuery,
} from '@server/lib/requestFilters';
import { getSettings } from '@server/lib/settings';
import {
  TraktNotConfiguredError,
  TraktNotLinkedError,
  createTraktAppClient,
  createTraktUserClient,
} from '@server/lib/trakt';
import {
  fetchPaginatedTraktAnimeItems,
  fetchPaginatedTraktNonAnimeItems,
} from '@server/lib/trakt/animeFilter';
import {
  filterWatchedMixedBrowseResults,
  filterWatchedTraktItems,
  loadWatchedIdSets,
} from '@server/lib/trakt/hideWatched';
import {
  TRAKT_RECOMMENDATIONS_ITEMS_PER_PAGE,
  getTraktRecommendationPage,
} from '@server/lib/trakt/recommendations';
import logger from '@server/logger';
import { mapProductionCompany } from '@server/models/Movie';
import type {
  CollectionResult,
  MovieResult,
  PersonResult,
  TvResult,
} from '@server/models/Search';
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

type BrowseResult = MovieResult | TvResult | PersonResult | CollectionResult;

async function applyBrowseDiscoverFilters<T extends BrowseResult>(
  results: T[],
  user: User | undefined,
  query: Request['query']
): Promise<T[]> {
  let filtered: T[];
  try {
    filtered = await filterDiscoverResults(results, query);
  } catch (e) {
    // Browse filtering/enrichment is optional. A failure in an external
    // provider or concurrent enrichment must not turn a TMDB browse into 500.
    logger.debug('Skipping Discover result filtering', {
      label: 'API',
      errorMessage: e instanceof Error ? e.message : 'unknown error',
    });
    filtered = results;
  }
  if (!user?.id) {
    return filtered;
  }

  const ignoreWatched = parseTraktTruthyQuery(query.ignoreWatched);
  if (!ignoreWatched) {
    return filtered;
  }

  try {
    const trakt = await createTraktUserClient(user.id);
    const watchedSets = await loadWatchedIdSets(user.id, trakt);
    return filterWatchedMixedBrowseResults(filtered, watchedSets);
  } catch (e) {
    // Hiding watched titles is optional. The persisted default is enabled for
    // existing users, so any unavailable Trakt account/API must not make
    // ordinary TMDB browse requests fail.
    logger.debug('Skipping watched-title filtering', {
      label: 'API',
      errorMessage: e instanceof Error ? e.message : 'unknown error',
    });
    return filtered;
  }
}

interface MapFilteredTraktItemsOptions {
  user?: User;
  query?: Request['query'];
  tmdb?: TheMovieDb;
  skipWatchedFilter?: boolean;
}

const mapFilteredTraktItems = async (
  items: TraktMediaItem[],
  options: MapFilteredTraktItemsOptions = {}
): Promise<WatchlistItem[]> => {
  const tmdb = options.tmdb ?? new TheMovieDb();
  let filtered = await filterTraktDiscoverItems(
    items,
    tmdb,
    options.query ?? {}
  );

  if (
    !options.skipWatchedFilter &&
    options.user?.id &&
    parseTraktTruthyQuery(options.query?.ignoreWatched)
  ) {
    try {
      const trakt = await createTraktUserClient(options.user.id);
      const watchedSets = await loadWatchedIdSets(options.user.id, trakt);
      filtered = filterWatchedTraktItems(filtered, watchedSets);
    } catch (e) {
      if (!(e instanceof TraktNotLinkedError)) {
        throw e;
      }
    }
  }

  return mapTraktItems(filtered);
};

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
  logger.error(fallbackMessage, {
    label: 'API',
    errorMessage: e instanceof Error ? e.message : 'unknown error',
  });
  return next({ status: 500, message: fallbackMessage });
};

function parseTraktMediaTypeQuery(
  value: unknown
): 'movie' | 'tv' | 'both' | 'anime' {
  if (value === 'movie' || value === 'tv' || value === 'anime') {
    return value;
  }
  return 'both';
}

function parseTraktListSortQuery(
  value: unknown
): { sortBy: 'added' | 'released'; sortHow: 'desc' } | undefined {
  if (value === 'added' || value === 'released') {
    return { sortBy: value, sortHow: 'desc' };
  }
  return undefined;
}

function toTraktFetchMediaType(
  mediaType: 'movie' | 'tv' | 'both' | 'anime'
): 'movie' | 'tv' | 'both' {
  return mediaType === 'anime' ? 'tv' : mediaType;
}

function parseTraktTruthyQuery(value: unknown): boolean {
  // OpenAPI boolean query params arrive as real booleans after validation.
  return value === true || value === 'true' || value === '1';
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

    const data = await tmdb.getDiscoverMovies({
      page: Number(query.page),
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

    return res.status(200).json({
      page: data.page,
      totalPages: data.total_pages,
      totalResults: data.total_results,
      keywords: keywordData,
      results: await applyBrowseDiscoverFilters(
        data.results.map((result) =>
          mapMovieResult(
            result,
            media.find(
              (req) =>
                req.tmdbId === result.id && req.mediaType === MediaType.MOVIE
            )
          )
        ),
        req.user,
        req.query
      ),
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

      const data = await tmdb.getDiscoverMovies({
        page: Number(req.query.page),
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

      return res.status(200).json({
        page: data.page,
        totalPages: data.total_pages,
        totalResults: data.total_results,
        language,
        results: await applyBrowseDiscoverFilters(
          data.results.map((result) =>
            mapMovieResult(
              result,
              media.find(
                (req) =>
                  req.tmdbId === result.id && req.mediaType === MediaType.MOVIE
              )
            )
          ),
          req.user,
          req.query
        ),
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

      const data = await tmdb.getDiscoverMovies({
        page: Number(req.query.page),
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

      return res.status(200).json({
        page: data.page,
        totalPages: data.total_pages,
        totalResults: data.total_results,
        genre,
        results: await applyBrowseDiscoverFilters(
          data.results.map((result) =>
            mapMovieResult(
              result,
              media.find(
                (req) =>
                  req.tmdbId === result.id && req.mediaType === MediaType.MOVIE
              )
            )
          ),
          req.user,
          req.query
        ),
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

      const data = await tmdb.getDiscoverMovies({
        page: Number(req.query.page),
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

      return res.status(200).json({
        page: data.page,
        totalPages: data.total_pages,
        totalResults: data.total_results,
        studio: mapProductionCompany(studio),
        results: await applyBrowseDiscoverFilters(
          data.results.map((result) =>
            mapMovieResult(
              result,
              media.find(
                (med) =>
                  med.tmdbId === result.id && med.mediaType === MediaType.MOVIE
              )
            )
          ),
          req.user,
          req.query
        ),
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
    const data = await tmdb.getDiscoverMovies({
      page: Number(req.query.page),
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

    return res.status(200).json({
      page: data.page,
      totalPages: data.total_pages,
      totalResults: data.total_results,
      results: await applyBrowseDiscoverFilters(
        data.results.map((result) =>
          mapMovieResult(
            result,
            media.find(
              (med) =>
                med.tmdbId === result.id && med.mediaType === MediaType.MOVIE
            )
          )
        ),
        req.user,
        req.query
      ),
    });
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
    const data = await tmdb.getDiscoverTv({
      page: Number(query.page),
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

    return res.status(200).json({
      page: data.page,
      totalPages: data.total_pages,
      totalResults: data.total_results,
      keywords: keywordData,
      results: await applyBrowseDiscoverFilters(
        data.results.map((result) =>
          mapTvResult(
            result,
            media.find(
              (med) =>
                med.tmdbId === result.id && med.mediaType === MediaType.TV
            )
          )
        ),
        req.user,
        req.query
      ),
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

      const data = await tmdb.getDiscoverTv({
        page: Number(req.query.page),
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

      return res.status(200).json({
        page: data.page,
        totalPages: data.total_pages,
        totalResults: data.total_results,
        language,
        results: await applyBrowseDiscoverFilters(
          data.results.map((result) =>
            mapTvResult(
              result,
              media.find(
                (med) =>
                  med.tmdbId === result.id && med.mediaType === MediaType.TV
              )
            )
          ),
          req.user,
          req.query
        ),
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

      const data = await tmdb.getDiscoverTv({
        page: Number(req.query.page),
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

      return res.status(200).json({
        page: data.page,
        totalPages: data.total_pages,
        totalResults: data.total_results,
        genre,
        results: await applyBrowseDiscoverFilters(
          data.results.map((result) =>
            mapTvResult(
              result,
              media.find(
                (med) =>
                  med.tmdbId === result.id && med.mediaType === MediaType.TV
              )
            )
          ),
          req.user,
          req.query
        ),
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

      const data = await tmdb.getDiscoverTv({
        page: Number(req.query.page),
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

      return res.status(200).json({
        page: data.page,
        totalPages: data.total_pages,
        totalResults: data.total_results,
        network: mapNetwork(network),
        results: await applyBrowseDiscoverFilters(
          data.results.map((result) =>
            mapTvResult(
              result,
              media.find(
                (med) =>
                  med.tmdbId === result.id && med.mediaType === MediaType.TV
              )
            )
          ),
          req.user,
          req.query
        ),
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
    const data = await tmdb.getDiscoverTv({
      page: Number(req.query.page),
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

    return res.status(200).json({
      page: data.page,
      totalPages: data.total_pages,
      totalResults: data.total_results,
      results: await applyBrowseDiscoverFilters(
        data.results.map((result) =>
          mapTvResult(
            result,
            media.find(
              (med) =>
                med.tmdbId === result.id && med.mediaType === MediaType.TV
            )
          )
        ),
        req.user,
        req.query
      ),
    });
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
    const page = Number(req.query.page);

    const trendingFetchers = {
      movie: async () => ({
        data: await tmdb.getMovieTrending({ page, language, timeWindow }),
        mapper: mapMovieResult,
        type: MediaType.MOVIE,
      }),
      tv: async () => ({
        data: await tmdb.getTvTrending({ page, language, timeWindow }),
        mapper: mapTvResult,
        type: MediaType.TV,
      }),
      all: async () => ({
        data: await tmdb.getAllTrending({ page, language, timeWindow }),
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

    const { data, mapper, type } = await trendingFetchers[mediaType]();

    const media = await Media.getRelatedMedia(
      req.user,
      data.results.map((result) => ({
        tmdbId: result.id,
        mediaType: isMovie(result) ? MediaType.MOVIE : MediaType.TV,
      }))
    );

    return res.status(200).json({
      page: data.page,
      totalPages: data.total_pages,
      totalResults: data.total_results,
      results: await applyBrowseDiscoverFilters(
        data.results.map((result) => {
          // - If "type" is set (case: "movie" or "tv"), the mediaType must also match.
          // - If "type" is not set (case: "all"), only filter by tmdbId.
          const selectedMedia = media.find(
            (med) =>
              med.tmdbId === result.id && (type ? med.mediaType === type : true)
          );

          return mapper(result, selectedMedia);
        }),
        req.user,
        req.query
      ),
    });
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
      const data = await tmdb.getMoviesByKeyword({
        keywordId: Number(req.params.keywordId),
        page: Number(req.query.page),
        language: (req.query.language as string) ?? req.locale,
      });

      const media = await Media.getRelatedMedia(
        req.user,
        data.results.map((result) => ({
          tmdbId: result.id,
          mediaType: MediaType.MOVIE,
        }))
      );

      return res.status(200).json({
        page: data.page,
        totalPages: data.total_pages,
        totalResults: data.total_results,
        results: await applyBrowseDiscoverFilters(
          data.results.map((result) =>
            mapMovieResult(
              result,
              media.find(
                (med) =>
                  med.tmdbId === result.id && med.mediaType === MediaType.MOVIE
              )
            )
          ),
          req.user,
          req.query
        ),
      });
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

    return res.json({
      page,
      totalPages: Math.ceil(watchlist.totalSize / itemsPerPage),
      totalResults: watchlist.totalSize,
      results: watchlist.items.map((item) => ({
        id: item.tmdbId,
        ratingKey: item.ratingKey,
        title: item.title,
        mediaType: item.type === 'show' ? 'tv' : 'movie',
        tmdbId: item.tmdbId,
      })),
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
    const { pageItems, totalPages, totalResults } =
      await getTraktRecommendationPage(
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

    return res.status(200).json({
      page,
      totalPages,
      totalResults,
      results: await mapFilteredTraktItems(pageItems, {
        user: req.user,
        query: req.query,
        tmdb,
        skipWatchedFilter: true,
      }),
    } satisfies WatchlistResponse);
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

    let items: TraktMediaItem[];
    let hasMore = false;
    if (mediaType === 'anime') {
      ({ items, hasMore } = await fetchPaginatedTraktAnimeItems(
        (traktPage) =>
          trakt.getWatchlistItems('me', traktFetchType, {
            page: traktPage,
            limit: itemsPerPage,
            extended,
          }),
        page,
        itemsPerPage,
        tmdb
      ));
    } else if (mediaType === 'tv') {
      ({ items, hasMore } = await fetchPaginatedTraktNonAnimeItems(
        (traktPage) =>
          trakt.getWatchlistItems('me', traktFetchType, {
            page: traktPage,
            limit: itemsPerPage,
            extended,
          }),
        page,
        itemsPerPage,
        tmdb
      ));
    } else {
      items = await trakt.getWatchlistItems('me', traktFetchType, {
        page,
        limit: itemsPerPage,
        extended,
      });
      hasMore = items.length >= itemsPerPage;
    }

    return res.status(200).json({
      page,
      // Trakt does not return total counts for watchlist pages; estimate
      totalPages: hasMore ? page + 1 : page,
      totalResults: (page - 1) * itemsPerPage + items.length,
      results: await mapFilteredTraktItems(items, {
        user: req.user,
        query: req.query,
        tmdb,
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

    let items: TraktMediaItem[];
    let hasMore = false;
    if (mediaType === 'anime') {
      ({ items, hasMore } = await fetchPaginatedTraktAnimeItems(
        (traktPage) =>
          trakt.getHistoryItems(traktFetchType, {
            page: traktPage,
            limit: itemsPerPage,
            extended,
          }),
        page,
        itemsPerPage,
        tmdb
      ));
    } else if (mediaType === 'tv') {
      ({ items, hasMore } = await fetchPaginatedTraktNonAnimeItems(
        (traktPage) =>
          trakt.getHistoryItems(traktFetchType, {
            page: traktPage,
            limit: itemsPerPage,
            extended,
          }),
        page,
        itemsPerPage,
        tmdb
      ));
    } else {
      items = await trakt.getHistoryItems(traktFetchType, {
        page,
        limit: itemsPerPage,
        extended,
      });
      hasMore = items.length >= itemsPerPage;
    }

    return res.status(200).json({
      page,
      // Trakt does not return total counts for history pages; estimate
      totalPages: hasMore ? page + 1 : page,
      totalResults: (page - 1) * itemsPerPage + items.length,
      results: await mapFilteredTraktItems(items, {
        user: req.user,
        query: req.query,
        tmdb,
        skipWatchedFilter: true,
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

discoverRoutes.get('/trakt/lists/:id', async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return next({ status: 401, message: 'Unauthorized' });
    }

    const page = req.query.page ? Number(req.query.page) : 1;
    const mediaType = parseTraktMediaTypeQuery(req.query.type);
    const itemsPerPage = 20;
    const listId = String(req.params.id);
    const trakt = await createTraktUserClient(req.user.id);
    const tmdb = createTmdbWithRegionLanguage(req.user);
    const traktFetchType = toTraktFetchMediaType(mediaType);
    const extended = traktExtendedForBrowseQuery(req.query);
    const listSort = parseTraktListSortQuery(req.query.sort);

    let items: TraktMediaItem[];
    let hasMore = false;
    if (mediaType === 'anime') {
      const fetchPage = (traktPage: number) =>
        listId === 'watchlist'
          ? trakt.getWatchlistItems('me', traktFetchType, {
              page: traktPage,
              limit: itemsPerPage,
              extended,
            })
          : trakt.getListItems('me', listId, traktFetchType, {
              page: traktPage,
              limit: itemsPerPage,
              extended,
              ...listSort,
            });
      ({ items, hasMore } = await fetchPaginatedTraktAnimeItems(
        fetchPage,
        page,
        itemsPerPage,
        tmdb
      ));
    } else if (mediaType === 'tv') {
      const fetchPage = (traktPage: number) =>
        listId === 'watchlist'
          ? trakt.getWatchlistItems('me', traktFetchType, {
              page: traktPage,
              limit: itemsPerPage,
              extended,
            })
          : trakt.getListItems('me', listId, traktFetchType, {
              page: traktPage,
              limit: itemsPerPage,
              extended,
              ...listSort,
            });
      ({ items, hasMore } = await fetchPaginatedTraktNonAnimeItems(
        fetchPage,
        page,
        itemsPerPage,
        tmdb
      ));
    } else if (listId === 'watchlist') {
      items = await trakt.getWatchlistItems('me', traktFetchType, {
        page,
        limit: itemsPerPage,
        extended,
      });
      hasMore = items.length >= itemsPerPage;
    } else {
      items = await trakt.getListItems('me', listId, traktFetchType, {
        page,
        limit: itemsPerPage,
        extended,
        ...listSort,
      });
      hasMore = items.length >= itemsPerPage;
    }

    return res.status(200).json({
      page,
      totalPages: hasMore ? page + 1 : page,
      totalResults: (page - 1) * itemsPerPage + items.length,
      results: await mapFilteredTraktItems(items, {
        user: req.user,
        query: req.query,
        tmdb,
      }),
    } satisfies WatchlistResponse);
  } catch (e) {
    return handleTraktRouteError(
      e,
      next,
      'Unable to retrieve Trakt list items.'
    );
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

    const { username, listRef } = TraktAPI.parseListUrl(url);
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

    let items: TraktMediaItem[];
    let metadataName = listRef;
    let hasMore = false;
    const tmdb = createTmdbWithRegionLanguage(req.user);
    const traktFetchType = toTraktFetchMediaType(mediaType);
    const extended = traktExtendedForBrowseQuery(req.query);
    const listSort = parseTraktListSortQuery(req.query.sort);

    if (listRef === 'watchlist') {
      if (!username) {
        return next({
          status: 400,
          message: 'Watchlist URL must include a username',
        });
      }
      if (mediaType === 'anime') {
        ({ items, hasMore } = await fetchPaginatedTraktAnimeItems(
          (traktPage) =>
            trakt.getWatchlistItems(username, traktFetchType, {
              page: traktPage,
              limit: itemsPerPage,
              extended,
            }),
          page,
          itemsPerPage,
          tmdb
        ));
      } else if (mediaType === 'tv') {
        ({ items, hasMore } = await fetchPaginatedTraktNonAnimeItems(
          (traktPage) =>
            trakt.getWatchlistItems(username, traktFetchType, {
              page: traktPage,
              limit: itemsPerPage,
              extended,
            }),
          page,
          itemsPerPage,
          tmdb
        ));
      } else {
        items = await trakt.getWatchlistItems(username, traktFetchType, {
          page,
          limit: itemsPerPage,
          extended,
        });
        hasMore = items.length >= itemsPerPage;
      }
      metadataName = `${username}'s Watchlist`;
    } else {
      try {
        const metadata = await trakt.getListMetadata(username, listRef);
        metadataName = metadata.name || listRef;
      } catch {
        // Metadata is optional for browsing items
      }
      if (mediaType === 'anime') {
        ({ items, hasMore } = await fetchPaginatedTraktAnimeItems(
          (traktPage) =>
            trakt.getListItems(username, listRef, traktFetchType, {
              page: traktPage,
              limit: itemsPerPage,
              extended,
              ...listSort,
            }),
          page,
          itemsPerPage,
          tmdb
        ));
      } else if (mediaType === 'tv') {
        ({ items, hasMore } = await fetchPaginatedTraktNonAnimeItems(
          (traktPage) =>
            trakt.getListItems(username, listRef, traktFetchType, {
              page: traktPage,
              limit: itemsPerPage,
              extended,
              ...listSort,
            }),
          page,
          itemsPerPage,
          tmdb
        ));
      } else {
        items = await trakt.getListItems(username, listRef, traktFetchType, {
          page,
          limit: itemsPerPage,
          extended,
          ...listSort,
        });
        hasMore = items.length >= itemsPerPage;
      }
    }

    return res.status(200).json({
      page,
      totalPages: hasMore ? page + 1 : page,
      totalResults: (page - 1) * itemsPerPage + items.length,
      results: await mapFilteredTraktItems(items, {
        user: req.user,
        query: req.query,
        tmdb,
      }),
      title: metadataName,
    });
  } catch (e) {
    return handleTraktRouteError(
      e,
      next,
      'Unable to retrieve Trakt public list.'
    );
  }
});

discoverRoutes.post('/trakt/lists/resolve', async (req, res, next) => {
  try {
    const url = String(req.body.url ?? '').trim();
    if (!url) {
      return next({ status: 400, message: 'url is required' });
    }

    const { username, listRef } = TraktAPI.parseListUrl(url);
    const trakt = createTraktAppClient();

    if (listRef === 'watchlist') {
      if (!username) {
        return next({
          status: 400,
          message: 'Watchlist URL must include a username',
        });
      }
      return res.status(200).json({
        id: 'watchlist',
        slug: 'watchlist',
        name: `${username}'s Watchlist`,
        username,
        isWatchlist: true,
        listUrl: url,
      });
    }

    const metadata = await trakt.getListMetadata(username, listRef);
    return res.status(200).json({
      ...metadata,
      listUrl: url,
    });
  } catch (e) {
    return handleTraktRouteError(e, next, 'Unable to resolve Trakt list URL.');
  }
});

export default discoverRoutes;
