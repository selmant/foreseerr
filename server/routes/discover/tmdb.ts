import type { SortOptions } from '@server/api/themoviedb';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbKeyword,
  TmdbMovieResult,
  TmdbSearchMultiResponse,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import { MediaType } from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { GenreSliderItem } from '@server/interfaces/api/discoverInterfaces';
import { ApiQuerySchema } from '@server/lib/discover/filterOptions';
import { paginateTmdbDiscover } from '@server/lib/discover/filteredPagination';
import {
  findRelatedMedia,
  getRelatedMediaIndex,
} from '@server/lib/discover/mediaResults';
import { createTmdbWithRegionLanguage } from '@server/lib/discover/tmdb';
import { toTmdbDiscoverGenres } from '@server/lib/tmdbGenreEquivalents';
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
import { Router } from 'express';
import { sortBy } from 'lodash';

const tmdbDiscoverRoutes = Router();

tmdbDiscoverRoutes.get('/movies', async (req, res, next) => {
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
          genre: toTmdbDiscoverGenres(query.genre, 'movie'),
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

        const media = await getRelatedMediaIndex(
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
              findRelatedMedia(media, result.id, MediaType.MOVIE)
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

tmdbDiscoverRoutes.get<{ language: string }>(
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

          const media = await getRelatedMediaIndex(
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
                findRelatedMedia(media, result.id, MediaType.MOVIE)
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

tmdbDiscoverRoutes.get<{ genreId: string }>(
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

          const media = await getRelatedMediaIndex(
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
                findRelatedMedia(media, result.id, MediaType.MOVIE)
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

tmdbDiscoverRoutes.get<{ studioId: string }>(
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

          const media = await getRelatedMediaIndex(
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
                findRelatedMedia(media, result.id, MediaType.MOVIE)
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

tmdbDiscoverRoutes.get('/movies/upcoming', async (req, res, next) => {
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

        const media = await getRelatedMediaIndex(
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
              findRelatedMedia(media, result.id, MediaType.MOVIE)
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

tmdbDiscoverRoutes.get('/tv', async (req, res, next) => {
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
          genre: toTmdbDiscoverGenres(query.genre, 'tv'),
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

        const media = await getRelatedMediaIndex(
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
              findRelatedMedia(media, result.id, MediaType.TV)
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

tmdbDiscoverRoutes.get<{ language: string }>(
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

          const media = await getRelatedMediaIndex(
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
                findRelatedMedia(media, result.id, MediaType.TV)
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

tmdbDiscoverRoutes.get<{ genreId: string }>(
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

          const media = await getRelatedMediaIndex(
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
                findRelatedMedia(media, result.id, MediaType.TV)
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

tmdbDiscoverRoutes.get<{ networkId: string }>(
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

          const media = await getRelatedMediaIndex(
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
                findRelatedMedia(media, result.id, MediaType.TV)
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

tmdbDiscoverRoutes.get('/tv/upcoming', async (req, res, next) => {
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

        const media = await getRelatedMediaIndex(
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
              findRelatedMedia(media, result.id, MediaType.TV)
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

tmdbDiscoverRoutes.get('/trending', async (req, res, next) => {
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
        mapper: (
          result: TmdbSearchMultiResponse['results'][number],
          media?: Media
        ) => mapMovieResult(result as TmdbMovieResult, media),
        type: MediaType.MOVIE,
      }),
      tv: async (upstreamPage: number) => ({
        data: await tmdb.getTvTrending({
          page: upstreamPage,
          language,
          timeWindow,
        }),
        mapper: (
          result: TmdbSearchMultiResponse['results'][number],
          media?: Media
        ) => mapTvResult(result as TmdbTvResult, media),
        type: MediaType.TV,
      }),
      all: async (upstreamPage: number) => ({
        data: await tmdb.getAllTrending({
          page: upstreamPage,
          language,
          timeWindow,
        }),
        mapper: (
          result: TmdbSearchMultiResponse['results'][number],
          media?: Media
        ) => {
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

        const media = await getRelatedMediaIndex(
          req.user,
          data.results.map((result) => ({
            tmdbId: result.id,
            mediaType: isMovie(result) ? MediaType.MOVIE : MediaType.TV,
          }))
        );

        return {
          items: data.results.map((result) => {
            const selectedMedia = findRelatedMedia(
              media,
              result.id,
              type ?? (isMovie(result) ? MediaType.MOVIE : MediaType.TV)
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

tmdbDiscoverRoutes.get<{ keywordId: string }>(
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

          const media = await getRelatedMediaIndex(
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
                findRelatedMedia(media, result.id, MediaType.MOVIE)
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

tmdbDiscoverRoutes.get<{ language: string }, GenreSliderItem[]>(
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

tmdbDiscoverRoutes.get<{ language: string }, GenreSliderItem[]>(
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

export default tmdbDiscoverRoutes;
