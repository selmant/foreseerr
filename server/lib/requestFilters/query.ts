import type { Request } from 'express';
import type { ParsedUrlQuery } from 'querystring';

type QueryInput = Request['query'] | ParsedUrlQuery;

export type BrowseQueryFilters = {
  voteAverageGte: number | null;
  voteAverageLte: number | null;
  voteCountGte: number | null;
  voteCountLte: number | null;
  genreIds: number[];
  language: string | null;
  releaseDateGte: string | null;
  releaseDateLte: string | null;
  imdbRatingGte: number | null;
  imdbRatingLte: number | null;
  imdbVotesGte: number | null;
  imdbVotesLte: number | null;
  rtCriticsGte: number | null;
  rtCriticsLte: number | null;
  rtAudienceGte: number | null;
  rtAudienceLte: number | null;
  metacriticGte: number | null;
  metacriticLte: number | null;
  traktRatingGte: number | null;
  traktRatingLte: number | null;
  includeNoRating: boolean;
};

const queryValue = (query: QueryInput, key: string): unknown => {
  const value = query[key];
  return Array.isArray(value) ? value[0] : value;
};

const nullableQueryNumber = (query: QueryInput, key: string): number | null => {
  const value = queryValue(query, key);
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const nullableQueryString = (query: QueryInput, key: string): string | null => {
  const value = queryValue(query, key);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

/** Parse shared FilterSlideover query params for post-fetch browse filtering. */
export const parseBrowseQueryFilters = (
  query: QueryInput
): BrowseQueryFilters => {
  const genreRaw = nullableQueryString(query, 'genre');
  const releaseDateGte =
    nullableQueryString(query, 'primaryReleaseDateGte') ??
    nullableQueryString(query, 'firstAirDateGte');
  const releaseDateLte =
    nullableQueryString(query, 'primaryReleaseDateLte') ??
    nullableQueryString(query, 'firstAirDateLte');

  return {
    voteAverageGte: nullableQueryNumber(query, 'voteAverageGte'),
    voteAverageLte: nullableQueryNumber(query, 'voteAverageLte'),
    voteCountGte: nullableQueryNumber(query, 'voteCountGte'),
    voteCountLte: nullableQueryNumber(query, 'voteCountLte'),
    genreIds: genreRaw
      ? genreRaw
          .split(',')
          .map((part) => Number(part.trim()))
          .filter((id) => Number.isFinite(id))
      : [],
    language: nullableQueryString(query, 'language'),
    releaseDateGte,
    releaseDateLte,
    imdbRatingGte: nullableQueryNumber(query, 'imdbRatingGte'),
    imdbRatingLte: nullableQueryNumber(query, 'imdbRatingLte'),
    imdbVotesGte: nullableQueryNumber(query, 'imdbVotesGte'),
    imdbVotesLte: nullableQueryNumber(query, 'imdbVotesLte'),
    rtCriticsGte: nullableQueryNumber(query, 'rtCriticsGte'),
    rtCriticsLte: nullableQueryNumber(query, 'rtCriticsLte'),
    rtAudienceGte: nullableQueryNumber(query, 'rtAudienceGte'),
    rtAudienceLte: nullableQueryNumber(query, 'rtAudienceLte'),
    metacriticGte: nullableQueryNumber(query, 'metacriticGte'),
    metacriticLte: nullableQueryNumber(query, 'metacriticLte'),
    traktRatingGte: nullableQueryNumber(query, 'traktRatingGte'),
    traktRatingLte: nullableQueryNumber(query, 'traktRatingLte'),
    includeNoRating: queryValue(query, 'includeNoRating') !== 'false',
  };
};

export const needsMdblistBrowseFilters = (
  filters: BrowseQueryFilters
): boolean =>
  filters.imdbRatingGte != null ||
  filters.imdbRatingLte != null ||
  filters.imdbVotesGte != null ||
  filters.imdbVotesLte != null ||
  filters.rtCriticsGte != null ||
  filters.rtCriticsLte != null ||
  filters.rtAudienceGte != null ||
  filters.rtAudienceLte != null ||
  filters.metacriticGte != null ||
  filters.metacriticLte != null ||
  filters.traktRatingGte != null ||
  filters.traktRatingLte != null;

/** Non-Trakt MDBList gates (IMDb/RT/Metacritic) — still need MDBList even if Trakt score is on the payload. */
export const needsNonTraktMdblistBrowseFilters = (
  filters: BrowseQueryFilters
): boolean =>
  filters.imdbRatingGte != null ||
  filters.imdbRatingLte != null ||
  filters.imdbVotesGte != null ||
  filters.imdbVotesLte != null ||
  filters.rtCriticsGte != null ||
  filters.rtCriticsLte != null ||
  filters.rtAudienceGte != null ||
  filters.rtAudienceLte != null ||
  filters.metacriticGte != null ||
  filters.metacriticLte != null;

export const needsTraktRatingBrowseFilters = (
  filters: BrowseQueryFilters
): boolean => filters.traktRatingGte != null || filters.traktRatingLte != null;

/** TMDB detail fields used by browse gates (vote/genre/language/date). */
export const needsTmdbBrowseFilters = (filters: BrowseQueryFilters): boolean =>
  filters.voteAverageGte != null ||
  filters.voteAverageLte != null ||
  filters.voteCountGte != null ||
  filters.voteCountLte != null ||
  filters.genreIds.length > 0 ||
  filters.language != null ||
  filters.releaseDateGte != null ||
  filters.releaseDateLte != null;

export const hasBrowseQueryFilters = (filters: BrowseQueryFilters): boolean =>
  needsTmdbBrowseFilters(filters) ||
  needsMdblistBrowseFilters(filters) ||
  filters.includeNoRating === false;
