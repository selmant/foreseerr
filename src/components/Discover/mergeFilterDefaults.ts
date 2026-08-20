import type { FilterOptions } from '@app/components/Discover/constants';
import type { DiscoverFilterDefaults } from '@server/lib/discover/filterDefaults';

const SESSION_CLEARED_KEY = 'seerr-discover-defaults-cleared';

const sessionClearedKey = (userId?: number): string =>
  `${SESSION_CLEARED_KEY}:${userId ?? 'anonymous'}`;

export const areDiscoverDefaultsCleared = (userId?: number): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    return window.sessionStorage.getItem(sessionClearedKey(userId)) === '1';
  } catch {
    return false;
  }
};

export const markDiscoverDefaultsCleared = (userId?: number): void => {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.sessionStorage.setItem(sessionClearedKey(userId), '1');
  } catch {
    // ignore quota / private mode
  }
};

const boolToQuery = (value: boolean): 'true' | 'false' =>
  value ? 'true' : 'false';

/**
 * Merge saved Discover defaults into URL-derived filters for UI + API calls.
 * Explicit URL values win. After "clear filters", defaults are suppressed for
 * the browser session.
 */
/**
 * When the user clears Discover filters for the session, API requests must
 * tell the server not to re-apply saved defaults.
 */
export const discoverDefaultsRequestExtras = (
  userId?: number
): Record<string, string> =>
  areDiscoverDefaultsCleared(userId) ? { ignoreDiscoverDefaults: 'true' } : {};

export const mergeFilterDefaults = (
  filters: FilterOptions,
  defaults: DiscoverFilterDefaults | null | undefined,
  userId?: number
): FilterOptions => {
  if (!defaults || areDiscoverDefaultsCleared(userId)) {
    return filters;
  }

  const merged: FilterOptions = { ...filters };

  if (
    merged.ignoreWatched == null &&
    typeof defaults.ignoreWatched === 'boolean'
  ) {
    merged.ignoreWatched = boolToQuery(defaults.ignoreWatched);
  }
  if (
    merged.ignoreCollected == null &&
    typeof defaults.ignoreCollected === 'boolean'
  ) {
    merged.ignoreCollected = boolToQuery(defaults.ignoreCollected);
  }
  if (
    merged.ignoreWatchlisted == null &&
    typeof defaults.ignoreWatchlisted === 'boolean'
  ) {
    merged.ignoreWatchlisted = boolToQuery(defaults.ignoreWatchlisted);
  }
  if (
    merged.includeNoRating == null &&
    typeof defaults.includeNoRating === 'boolean'
  ) {
    merged.includeNoRating = boolToQuery(defaults.includeNoRating);
  }

  const stringKeys: (keyof DiscoverFilterDefaults & keyof FilterOptions)[] = [
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
  ];

  for (const key of stringKeys) {
    const value = defaults[key];
    if (merged[key] == null && typeof value === 'string') {
      (merged as Record<string, string | undefined>)[key] = value;
    }
  }

  return merged;
};
