import type { TmdbKeyword } from './interfaces';

export type TmdbKeywordListInput =
  | TmdbKeyword[]
  | { keywords?: TmdbKeyword[]; results?: TmdbKeyword[] }
  | null
  | undefined;

/**
 * Normalize TMDB keyword payloads.
 * Movies use `{ keywords: [...] }`; TV uses `{ results: [...] }`.
 */
export const extractKeywordList = (
  keywords: TmdbKeywordListInput
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
