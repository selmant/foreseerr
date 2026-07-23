import type { RatingResponse } from '@server/api/ratings';
import TheMovieDb from '@server/api/themoviedb';
import type { TraktMediaItem } from '@server/api/trakt/interfaces';
import {
  EXTERNAL_ENRICHMENT_CONCURRENCY,
  mapWithConcurrency,
} from '@server/lib/concurrency';
import {
  fetchBatchCombinedRatings,
  fetchCombinedRatings,
} from '@server/lib/ratings';
import { getSettings } from '@server/lib/settings';
import type {
  CollectionResult,
  MovieResult,
  PersonResult,
  TvResult,
} from '@server/models/Search';
import {
  hasBrowseQueryFilters,
  needsMdblistBrowseFilters,
  needsNonTraktMdblistBrowseFilters,
  needsTmdbBrowseFilters,
  needsTraktRatingBrowseFilters,
  parseBrowseQueryFilters,
  type BrowseQueryFilters,
} from './query';

type BrowseResult = MovieResult | TvResult | PersonResult | CollectionResult;
type QueryLike = Parameters<typeof parseBrowseQueryFilters>[0];

type ExternalRatings = {
  imdbRating?: number | null;
  imdbVotes?: number | null;
  rtCriticsScore?: number | null;
  rtAudienceScore?: number | null;
  metacriticScore?: number | null;
  traktRating?: number | null;
};

const isMovieOrTv = (item: BrowseResult): item is MovieResult | TvResult =>
  item.mediaType === 'movie' || item.mediaType === 'tv';

const releaseDateForItem = (item: MovieResult | TvResult): string | null => {
  if (item.mediaType === 'movie') {
    return item.releaseDate || null;
  }
  return item.firstAirDate || null;
};

const releaseYearFromDate = (date?: string | null): number | undefined => {
  if (!date) {
    return undefined;
  }
  const year = Number(String(date).slice(0, 4));
  return Number.isFinite(year) && year > 0 ? year : undefined;
};

const passesScoreRange = (
  score: number | null | undefined,
  gte: number | null,
  lte: number | null,
  includeNoRating: boolean
): boolean => {
  if (gte == null && lte == null) {
    return true;
  }
  if (score == null || !Number.isFinite(score)) {
    return includeNoRating;
  }
  if (gte != null && score < gte) {
    return false;
  }
  if (lte != null && score > lte) {
    return false;
  }
  return true;
};

const matchesBrowseFilters = (
  item: {
    voteAverage: number;
    voteCount: number;
    genreIds: number[];
    originalLanguage?: string;
    releaseDate?: string | null;
  },
  filters: BrowseQueryFilters,
  external: ExternalRatings = {}
): boolean => {
  if (
    filters.voteAverageGte != null &&
    !(
      Number.isFinite(item.voteAverage) &&
      item.voteAverage >= filters.voteAverageGte
    )
  ) {
    return false;
  }
  if (
    filters.voteAverageLte != null &&
    !(
      Number.isFinite(item.voteAverage) &&
      item.voteAverage <= filters.voteAverageLte
    )
  ) {
    return false;
  }
  if (
    filters.voteCountGte != null &&
    !(Number.isFinite(item.voteCount) && item.voteCount >= filters.voteCountGte)
  ) {
    return false;
  }
  if (
    filters.voteCountLte != null &&
    !(Number.isFinite(item.voteCount) && item.voteCount <= filters.voteCountLte)
  ) {
    return false;
  }
  if (
    filters.genreIds.length > 0 &&
    !filters.genreIds.some((id) => item.genreIds.includes(id))
  ) {
    return false;
  }
  if (
    filters.language != null &&
    item.originalLanguage?.toLowerCase() !== filters.language.toLowerCase()
  ) {
    return false;
  }
  const releaseDate = item.releaseDate ?? null;
  if (filters.releaseDateGte != null) {
    if (!releaseDate || releaseDate < filters.releaseDateGte) {
      return false;
    }
  }
  if (filters.releaseDateLte != null) {
    if (!releaseDate || releaseDate > filters.releaseDateLte) {
      return false;
    }
  }

  if (
    !passesScoreRange(
      external.imdbRating,
      filters.imdbRatingGte,
      filters.imdbRatingLte,
      filters.includeNoRating
    )
  ) {
    return false;
  }
  if (
    !passesScoreRange(
      external.imdbVotes,
      filters.imdbVotesGte,
      filters.imdbVotesLte,
      filters.includeNoRating
    )
  ) {
    return false;
  }
  if (
    !passesScoreRange(
      external.rtCriticsScore,
      filters.rtCriticsGte,
      filters.rtCriticsLte,
      filters.includeNoRating
    )
  ) {
    return false;
  }
  if (
    !passesScoreRange(
      external.rtAudienceScore,
      filters.rtAudienceGte,
      filters.rtAudienceLte,
      filters.includeNoRating
    )
  ) {
    return false;
  }
  if (
    !passesScoreRange(
      external.metacriticScore,
      filters.metacriticGte,
      filters.metacriticLte,
      filters.includeNoRating
    )
  ) {
    return false;
  }
  if (
    !passesScoreRange(
      external.traktRating,
      filters.traktRatingGte,
      filters.traktRatingLte,
      filters.includeNoRating
    )
  ) {
    return false;
  }

  return true;
};

const externalRatingsFromResponse = (
  ratings?: RatingResponse | null
): ExternalRatings => ({
  imdbRating: ratings?.imdb?.criticsScore ?? null,
  imdbVotes: ratings?.imdb?.criticsScoreCount ?? null,
  rtCriticsScore: ratings?.rt?.criticsScore ?? null,
  rtAudienceScore: ratings?.rt?.audienceScore ?? null,
  metacriticScore: ratings?.metacritic?.score ?? null,
  traktRating: ratings?.trakt?.rating ?? null,
});

/**
 * Whether MDBList is still required after using Trakt extended=full community rating.
 */
const needsMdblistFetchForItem = (
  filters: BrowseQueryFilters,
  traktCommunityRating?: number | null
): boolean => {
  if (needsNonTraktMdblistBrowseFilters(filters)) {
    return true;
  }
  if (
    needsTraktRatingBrowseFilters(filters) &&
    (traktCommunityRating == null || !Number.isFinite(traktCommunityRating))
  ) {
    return true;
  }
  return false;
};

/**
 * Filter Discover title-card results by shared FilterSlideover query params.
 * Person/collection rows pass through unchanged.
 *
 * When MDBList rating filters are active, callers must pre-enrich results via
 * `enrichResultsWithRatings` so this pass can read `item.ratings`.
 */
export const filterDiscoverResults = async <T extends BrowseResult>(
  results: T[],
  query: QueryLike = {}
): Promise<T[]> => {
  const filters = parseBrowseQueryFilters(query);
  if (!hasBrowseQueryFilters(filters) || !results.length) {
    return results;
  }

  const needMdblist = needsMdblistBrowseFilters(filters);

  const decisions = results.map((item): T | null => {
    if (!isMovieOrTv(item)) {
      return item;
    }

    const external: ExternalRatings = needMdblist
      ? externalRatingsFromResponse(item.ratings)
      : {};

    if (
      matchesBrowseFilters(
        {
          voteAverage: item.voteAverage,
          voteCount: item.voteCount,
          genreIds: item.genreIds ?? [],
          originalLanguage: item.originalLanguage,
          releaseDate: releaseDateForItem(item),
        },
        filters,
        external
      )
    ) {
      return item;
    }
    return null;
  });

  return decisions.filter((item): item is T => item != null);
};

/**
 * Filter Trakt browse items using the same FilterSlideover query params.
 * Fetches slim TMDB metadata when rating/genre/language/date gates are set.
 */
export const filterTraktDiscoverItems = async (
  items: TraktMediaItem[],
  tmdb: TheMovieDb = new TheMovieDb(),
  query: QueryLike = {}
): Promise<TraktMediaItem[]> => {
  const filters = parseBrowseQueryFilters(query);
  if (!hasBrowseQueryFilters(filters) || !items.length) {
    return items;
  }

  const needTmdb = needsTmdbBrowseFilters(filters);
  const mdblistConfigured = Boolean(getSettings().mdblist?.apiKey?.trim());
  const itemsNeedingMdblist = items.filter((item) =>
    needsMdblistFetchForItem(filters, item.traktCommunityRating)
  );

  const ratingsByKey = new Map<string, RatingResponse | null>();
  if (mdblistConfigured && itemsNeedingMdblist.length) {
    const batch = await fetchBatchCombinedRatings(
      itemsNeedingMdblist.map((item) => ({
        mediaType: item.mediaType,
        tmdbId: item.tmdbId,
        title: item.title,
        year: item.year,
      }))
    );
    for (const row of batch) {
      ratingsByKey.set(`${row.mediaType}:${row.tmdbId}`, row.ratings);
    }
  }

  const decisions = await mapWithConcurrency(
    items,
    EXTERNAL_ENRICHMENT_CONCURRENCY,
    async (item): Promise<TraktMediaItem | null> => {
      let voteAverage = 0;
      let voteCount = 0;
      let releaseDate: string | null =
        item.year != null ? `${item.year}-01-01` : null;
      let genreIds: number[] = [];
      let originalLanguage: string | undefined;
      let title = item.title;

      if (needTmdb) {
        try {
          if (item.mediaType === 'movie') {
            const movie = await tmdb.getMovieBrowseMetadata({
              movieId: item.tmdbId,
            });
            voteAverage = movie.vote_average;
            voteCount = movie.vote_count;
            releaseDate = movie.release_date || releaseDate;
            genreIds = movie.genre_ids;
            originalLanguage = movie.original_language;
            title = movie.title;
          } else {
            const show = await tmdb.getTvBrowseMetadata({
              tvId: item.tmdbId,
            });
            voteAverage = show.vote_average;
            voteCount = show.vote_count;
            releaseDate = show.release_date || releaseDate;
            genreIds = show.genre_ids;
            originalLanguage = show.original_language;
            title = show.title;
          }
        } catch {
          return null;
        }
      }

      let external: ExternalRatings = {};
      if (item.traktCommunityRating != null) {
        external.traktRating = item.traktCommunityRating;
      }

      if (needsMdblistFetchForItem(filters, item.traktCommunityRating)) {
        const cached = ratingsByKey.get(`${item.mediaType}:${item.tmdbId}`);
        if (cached !== undefined) {
          external = {
            ...externalRatingsFromResponse(cached),
            traktRating:
              item.traktCommunityRating ??
              cached?.trakt?.rating ??
              external.traktRating ??
              null,
          };
        } else {
          try {
            const fetched = externalRatingsFromResponse(
              await fetchCombinedRatings({
                mediaType: item.mediaType,
                tmdbId: item.tmdbId,
                title,
                year:
                  releaseYearFromDate(releaseDate) ?? item.year ?? undefined,
                releaseDate,
              })
            );
            external = {
              ...fetched,
              traktRating:
                item.traktCommunityRating ?? fetched.traktRating ?? null,
            };
          } catch {
            // Optional enrichment — keep filtering with available metadata.
          }
        }
      }

      if (
        matchesBrowseFilters(
          {
            voteAverage,
            voteCount,
            genreIds,
            originalLanguage,
            releaseDate,
          },
          filters,
          external
        )
      ) {
        return item;
      }
      return null;
    }
  );

  return decisions.filter((item): item is TraktMediaItem => item != null);
};
