import type { MdblistMediaPayload, ParsedMdblistRatings } from './types';

const scoreToTen = (score: unknown): number | undefined => {
  if (score === null || score === undefined || score === '') {
    return undefined;
  }
  const n = Number(score);
  if (!Number.isFinite(n)) {
    return undefined;
  }
  return Math.round(n) / 10;
};

const scoreToPercent = (score: unknown): number | undefined => {
  if (score === null || score === undefined || score === '') {
    return undefined;
  }
  const n = Number(score);
  if (!Number.isFinite(n)) {
    return undefined;
  }
  return Math.round(n);
};

const toInt = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return undefined;
  }
  return Math.trunc(n);
};

const indexRatings = (
  payload: MdblistMediaPayload
): Record<string, NonNullable<MdblistMediaPayload['ratings']>[number]> => {
  const indexed: Record<
    string,
    NonNullable<MdblistMediaPayload['ratings']>[number]
  > = {};
  for (const entry of payload.ratings ?? []) {
    if (entry?.source) {
      indexed[entry.source] = entry;
    }
  }
  return indexed;
};

/**
 * Map an MDBList media-info payload onto normalized rating fields.
 * Uses the normalised `score` (0–100) for every source so scales are consistent.
 */
export const parseMdblistRatings = (
  payload: MdblistMediaPayload
): ParsedMdblistRatings => {
  const ratings = indexRatings(payload);
  const score = (source: string) => ratings[source]?.score;
  const votes = (source: string) => ratings[source]?.votes;
  const ids = payload.ids ?? {};

  return {
    imdbId: ids.imdb,
    imdbRating: scoreToTen(score('imdb')),
    imdbVotes: toInt(votes('imdb')),
    rtRating: scoreToPercent(score('tomatoes')),
    rtUserRating: scoreToPercent(score('popcorn')),
    metacriticRating: scoreToPercent(score('metacritic')),
    traktRating: scoreToTen(score('trakt')),
    traktVotes: toInt(votes('trakt')),
    tmdbRating: scoreToTen(score('tmdb')),
  };
};
