import TheMovieDb from '@server/api/themoviedb';
import type { TraktMediaItem } from '@server/api/trakt/interfaces';
import { fetchCombinedRatings } from '@server/lib/ratings';
import { getSettings } from '@server/lib/settings';
import type {
  CollectionResult,
  MovieResult,
  PersonResult,
  TvResult,
} from '@server/models/Search';
import {
  isEligibleForDiscover,
  type EligibilityMediaInput,
} from './eligibility';
import {
  hasAnyQualityGate,
  needsMdblistRatings,
  type RequestFiltersSettings,
} from './types';

type BrowseResult = MovieResult | TvResult | PersonResult | CollectionResult;

const releaseYearFromDate = (date?: string | null): number | null => {
  if (!date) {
    return null;
  }
  const year = Number(String(date).slice(0, 4));
  return Number.isFinite(year) && year > 0 ? year : null;
};

const isMovieOrTv = (item: BrowseResult): item is MovieResult | TvResult =>
  item.mediaType === 'movie' || item.mediaType === 'tv';

const toEligibilityFromBrowse = (
  item: MovieResult | TvResult,
  external?: Partial<EligibilityMediaInput>
): EligibilityMediaInput => ({
  mediaType: item.mediaType,
  voteAverage: item.voteAverage,
  voteCount: item.voteCount,
  releaseYear:
    item.mediaType === 'movie'
      ? releaseYearFromDate(item.releaseDate)
      : releaseYearFromDate(item.firstAirDate),
  genreIds: item.genreIds ?? [],
  imdbRating: external?.imdbRating ?? null,
  imdbVotes: external?.imdbVotes ?? null,
  rtCriticsScore: external?.rtCriticsScore ?? null,
  rtAudienceScore: external?.rtAudienceScore ?? null,
  metacriticScore: external?.metacriticScore ?? null,
  traktRating: external?.traktRating ?? null,
});

const fetchExternalRatings = async (
  mediaType: 'movie' | 'tv',
  tmdbId: number,
  title: string,
  year?: number
): Promise<Partial<EligibilityMediaInput>> => {
  try {
    const ratings = await fetchCombinedRatings({
      mediaType,
      tmdbId,
      title,
      year,
    });
    return {
      imdbRating: ratings?.imdb?.criticsScore ?? null,
      imdbVotes: ratings?.imdb?.criticsScoreCount ?? null,
      rtCriticsScore: ratings?.rt?.criticsScore ?? null,
      rtAudienceScore: ratings?.rt?.audienceScore ?? null,
      metacriticScore: ratings?.metacritic?.score ?? null,
      traktRating: ratings?.trakt?.rating ?? null,
    };
  } catch {
    return {};
  }
};

/**
 * Filter Discover title-card results by configured quality gates.
 * Person/collection rows pass through unchanged.
 */
export const filterDiscoverResults = async <T extends BrowseResult>(
  results: T[],
  settings: RequestFiltersSettings = getSettings().requestFilters
): Promise<T[]> => {
  if (!hasAnyQualityGate(settings) || !results.length) {
    return results;
  }

  const needMdblist = needsMdblistRatings(settings);

  const kept: T[] = [];
  for (const item of results) {
    if (!isMovieOrTv(item)) {
      kept.push(item);
      continue;
    }

    let external: Partial<EligibilityMediaInput> = {};
    if (needMdblist) {
      const title = item.mediaType === 'movie' ? item.title : item.name;
      const year =
        item.mediaType === 'movie'
          ? (releaseYearFromDate(item.releaseDate) ?? undefined)
          : (releaseYearFromDate(item.firstAirDate) ?? undefined);
      external = await fetchExternalRatings(
        item.mediaType,
        item.id,
        title,
        year
      );
    }

    if (
      isEligibleForDiscover(settings, toEligibilityFromBrowse(item, external))
    ) {
      kept.push(item);
    }
  }

  return kept;
};

/**
 * Filter Trakt browse items. Fetches TMDB metadata when TMDB/genre/year gates
 * are set; uses MDBList when those thresholds are set.
 */
export const filterTraktDiscoverItems = async (
  items: TraktMediaItem[],
  tmdb: TheMovieDb = new TheMovieDb(),
  settings: RequestFiltersSettings = getSettings().requestFilters
): Promise<TraktMediaItem[]> => {
  if (!hasAnyQualityGate(settings) || !items.length) {
    return items;
  }

  const needMdblist = needsMdblistRatings(settings);
  const needTmdbMeta =
    settings.tmdbThreshold != null ||
    settings.tmdbMinVotes != null ||
    settings.minReleaseYear != null ||
    settings.excludedGenreIds.length > 0;

  const kept: TraktMediaItem[] = [];

  for (const item of items) {
    let voteAverage = 0;
    let voteCount = 0;
    let releaseYear: number | null = item.year ?? null;
    let genreIds: number[] = [];
    let title = item.title;

    if (needTmdbMeta) {
      try {
        if (item.mediaType === 'movie') {
          const movie = await tmdb.getMovie({ movieId: item.tmdbId });
          voteAverage = movie.vote_average;
          voteCount = movie.vote_count;
          releaseYear = releaseYearFromDate(movie.release_date);
          genreIds = movie.genres.map((genre) => genre.id);
          title = movie.title;
        } else {
          const show = await tmdb.getTvShow({ tvId: item.tmdbId });
          voteAverage = show.vote_average;
          voteCount = show.vote_count;
          releaseYear = releaseYearFromDate(show.first_air_date);
          genreIds = show.genres.map((genre) => genre.id);
          title = show.name;
        }
      } catch {
        if (!settings.includeNoRating) {
          continue;
        }
      }
    }

    let external: Partial<EligibilityMediaInput> = {};
    if (needMdblist) {
      external = await fetchExternalRatings(
        item.mediaType,
        item.tmdbId,
        title,
        releaseYear ?? undefined
      );
    }

    if (
      isEligibleForDiscover(settings, {
        mediaType: item.mediaType,
        voteAverage,
        voteCount,
        releaseYear,
        genreIds,
        ...external,
      })
    ) {
      kept.push(item);
    }
  }

  return kept;
};
