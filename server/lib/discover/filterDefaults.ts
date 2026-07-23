import { z } from 'zod';

const optionalString = z.string().min(1).optional();

/**
 * Persisted per-user Discover browse filter defaults.
 * Booleans are JSON booleans; other keys match Discover URL string shapes.
 */
export const DiscoverFilterDefaultsSchema = z
  .object({
    ignoreWatched: z.boolean().optional(),
    ignoreCollected: z.boolean().optional(),
    ignoreWatchlisted: z.boolean().optional(),
    includeNoRating: z.boolean().optional(),
    language: optionalString,
    primaryReleaseDateGte: optionalString,
    primaryReleaseDateLte: optionalString,
    firstAirDateGte: optionalString,
    firstAirDateLte: optionalString,
    genre: optionalString,
    voteAverageGte: optionalString,
    voteAverageLte: optionalString,
    voteCountGte: optionalString,
    voteCountLte: optionalString,
    imdbRatingGte: optionalString,
    imdbRatingLte: optionalString,
    imdbVotesGte: optionalString,
    imdbVotesLte: optionalString,
    rtCriticsGte: optionalString,
    rtCriticsLte: optionalString,
    rtAudienceGte: optionalString,
    rtAudienceLte: optionalString,
    metacriticGte: optionalString,
    metacriticLte: optionalString,
    traktRatingGte: optionalString,
    traktRatingLte: optionalString,
  })
  .strict();

export type DiscoverFilterDefaults = z.infer<
  typeof DiscoverFilterDefaultsSchema
>;

const BOOLEAN_KEYS = [
  'ignoreWatched',
  'ignoreCollected',
  'ignoreWatchlisted',
  'includeNoRating',
] as const;

const STRING_KEYS = [
  'language',
  'primaryReleaseDateGte',
  'primaryReleaseDateLte',
  'firstAirDateGte',
  'firstAirDateLte',
  'genre',
  'voteAverageGte',
  'voteAverageLte',
  'voteCountGte',
  'voteCountLte',
  'imdbRatingGte',
  'imdbRatingLte',
  'imdbVotesGte',
  'imdbVotesLte',
  'rtCriticsGte',
  'rtCriticsLte',
  'rtAudienceGte',
  'rtAudienceLte',
  'metacriticGte',
  'metacriticLte',
  'traktRatingGte',
  'traktRatingLte',
] as const;

export function parseDiscoverFilterDefaults(
  input: unknown
): DiscoverFilterDefaults {
  return DiscoverFilterDefaultsSchema.parse(input ?? {});
}

export function safeParseDiscoverFilterDefaults(
  input: unknown
): DiscoverFilterDefaults {
  const result = DiscoverFilterDefaultsSchema.safeParse(input ?? {});
  if (!result.success) {
    return {};
  }
  return result.data;
}

type QueryBag = Record<string, unknown>;

const queryHasKey = (query: QueryBag, key: string): boolean => {
  if (!Object.prototype.hasOwnProperty.call(query, key)) {
    return false;
  }
  const value = query[key];
  if (value === undefined) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0 && value[0] !== undefined && value[0] !== null;
  }
  return true;
};

/**
 * Merge user defaults into a query bag. Explicit query keys always win.
 * Boolean defaults are written as 'true' / 'false' strings for parser compatibility.
 */
export function applyDiscoverFilterDefaultsToQuery<T extends QueryBag>(
  query: T,
  defaults: DiscoverFilterDefaults | null | undefined
): T {
  if (!defaults || Object.keys(defaults).length === 0) {
    return query;
  }

  const merged: QueryBag = { ...query };

  for (const key of BOOLEAN_KEYS) {
    if (queryHasKey(merged, key)) {
      continue;
    }
    const value = defaults[key];
    if (typeof value === 'boolean') {
      merged[key] = value ? 'true' : 'false';
    }
  }

  for (const key of STRING_KEYS) {
    if (queryHasKey(merged, key)) {
      continue;
    }
    const value = defaults[key];
    if (typeof value === 'string' && value.length > 0) {
      merged[key] = value;
    }
  }

  return merged as T;
}

export function resolveIgnoreWatchedFromDefaults(
  defaults: DiscoverFilterDefaults | null | undefined,
  queryValue: unknown
): boolean {
  if (queryValue === true || queryValue === 'true' || queryValue === '1') {
    return true;
  }
  if (queryValue === false || queryValue === 'false' || queryValue === '0') {
    return false;
  }
  return defaults?.ignoreWatched === true;
}
