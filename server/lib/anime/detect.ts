import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import type { TmdbKeyword } from '@server/api/themoviedb/interfaces';

export const ANIMATION_GENRE_ID = 16;
export const ANIME_KEYWORD_NAMES = new Set(['anime', 'japanese animation']);
const JAPANESE_LANGUAGE = 'ja';
const JAPAN_COUNTRY = 'JP';

export type AnimeDetectionInput = {
  genres?: { id: number }[] | number[];
  original_language?: string | null;
  origin_country?: string[] | null;
  production_countries?: { iso_3166_1: string }[] | null;
  keywords?:
    | TmdbKeyword[]
    | { keywords?: TmdbKeyword[]; results?: TmdbKeyword[] }
    | null;
};

export const extractKeywordList = (
  keywords: AnimeDetectionInput['keywords']
): TmdbKeyword[] => {
  if (!keywords) {
    return [];
  }
  if (Array.isArray(keywords)) {
    return keywords;
  }
  if ('keywords' in keywords && Array.isArray(keywords.keywords)) {
    return keywords.keywords;
  }
  if ('results' in keywords && Array.isArray(keywords.results)) {
    return keywords.results;
  }
  return [];
};

const genreIds = (genres: AnimeDetectionInput['genres']): Set<number> => {
  if (!genres?.length) {
    return new Set();
  }
  if (typeof genres[0] === 'number') {
    return new Set(genres as number[]);
  }
  return new Set((genres as { id: number }[]).map((genre) => genre.id));
};

const countryCodes = (input: AnimeDetectionInput): Set<string> => {
  const codes = new Set<string>();
  for (const code of input.origin_country ?? []) {
    if (code) {
      codes.add(String(code).trim().toUpperCase());
    }
  }
  for (const country of input.production_countries ?? []) {
    if (country?.iso_3166_1) {
      codes.add(String(country.iso_3166_1).trim().toUpperCase());
    }
  }
  return codes;
};

/**
 * SuggestArr-compatible anime detection for request routing.
 * True when TMDB anime keyword is present, keyword names match anime,
 * or Animation + (Japanese language or Japan origin).
 */
export const isAnimeMedia = (input: AnimeDetectionInput): boolean => {
  const keywords = extractKeywordList(input.keywords);

  if (keywords.some((keyword) => keyword.id === ANIME_KEYWORD_ID)) {
    return true;
  }

  if (
    keywords.some((keyword) =>
      ANIME_KEYWORD_NAMES.has(
        String(keyword.name ?? '')
          .trim()
          .toLowerCase()
      )
    )
  ) {
    return true;
  }

  if (!genreIds(input.genres).has(ANIMATION_GENRE_ID)) {
    return false;
  }

  const language = String(input.original_language ?? '')
    .trim()
    .toLowerCase();
  if (language === JAPANESE_LANGUAGE) {
    return true;
  }

  return countryCodes(input).has(JAPAN_COUNTRY);
};
