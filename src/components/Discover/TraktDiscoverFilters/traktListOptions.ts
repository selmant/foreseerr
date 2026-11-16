/**
 * Trakt list sorts and the filter count the Trakt pages share. Kept free of
 * React so the rules are unit-tested.
 */
import type { FilterOptions } from '@app/components/Discover/constants';
import { countActiveFilters } from '@app/components/Discover/constants';
import type { ListSortOption } from '@app/components/Discover/listSort';
import { defaultOrderForKind } from '@app/components/Discover/listSort';

/**
 * Trakt's list sorts (`sort_by`) as trakt.tv's list menu offers them.
 * Without one, Trakt keeps the order the list's owner picked.
 */
export const traktListSortOptions = [
  { value: 'rank', kind: 'position', group: 'list' },
  { value: 'added', kind: 'date', group: 'list' },
  { value: 'title', kind: 'alpha', group: 'list' },
  { value: 'released', kind: 'date', group: 'release' },
  { value: 'percentage', kind: 'number', group: 'ratings' },
  { value: 'imdb_rating', kind: 'number', group: 'ratings', vip: true },
  { value: 'tmdb_rating', kind: 'number', group: 'ratings', vip: true },
  { value: 'rt_tomatometer', kind: 'number', group: 'ratings', vip: true },
  { value: 'rt_audience', kind: 'number', group: 'ratings', vip: true },
  { value: 'metascore', kind: 'number', group: 'ratings', vip: true },
  { value: 'popularity', kind: 'number', group: 'popularity' },
  { value: 'votes', kind: 'number', group: 'popularity' },
  { value: 'imdb_votes', kind: 'number', group: 'popularity', vip: true },
  { value: 'tmdb_votes', kind: 'number', group: 'popularity', vip: true },
  { value: 'runtime', kind: 'number', group: 'details' },
  { value: 'my_rating', kind: 'number', group: 'activity', personal: true },
  { value: 'watched', kind: 'date', group: 'activity', personal: true },
  { value: 'collected', kind: 'date', group: 'activity', personal: true },
] as const satisfies readonly ListSortOption<string>[];

export type TraktListSort = (typeof traktListSortOptions)[number]['value'];

/** A watchlist link reads Trakt's watchlist, which only sorts by date. */
export const traktWatchlistSortOptions = [
  { value: 'added', kind: 'date', group: 'list' },
  { value: 'released', kind: 'date', group: 'release' },
] as const satisfies readonly ListSortOption<string>[];

export const isWatchlistUrl = (url: unknown) =>
  typeof url === 'string' && /\/watchlist\/?(?:[?#]|$)/.test(url);

export const traktSortOption = (sort: string) =>
  (traktListSortOptions as readonly ListSortOption<TraktListSort>[]).find(
    (o) => o.value === sort
  );

/** Rank and title read top-down / A→Z; dates, ratings, counts high→low. */
export const defaultTraktSortHow = (sort: string): 'asc' | 'desc' =>
  defaultOrderForKind(traktSortOption(sort)?.kind ?? 'number');

/**
 * How many filters the Trakt panel narrows by. An explicit `false` (what
 * "Clear" writes to keep saved defaults off) shows everything, so it is
 * not a filter.
 */
export const countTraktFilters = (
  filters: FilterOptions,
  {
    showHideWatched = true,
    showRecommendationFilters = false,
  }: { showHideWatched?: boolean; showRecommendationFilters?: boolean } = {}
) =>
  countActiveFilters(filters) +
  (showHideWatched && filters.ignoreWatched === 'true' ? 1 : 0) +
  (showRecommendationFilters && filters.ignoreCollected === 'true' ? 1 : 0) +
  (showRecommendationFilters && filters.ignoreWatchlisted === 'true' ? 1 : 0) +
  (filters.hideUnmapped === 'true' ? 1 : 0);

/** The route update the panel's "Clear" makes, for the empty state. */
export const traktClearParams = (filters: FilterOptions) => ({
  ...Object.fromEntries(Object.keys(filters).map((k) => [k, undefined])),
  ignoreWatched: 'false',
  ignoreCollected: 'false',
  ignoreWatchlisted: 'false',
  hideUnmapped: 'false',
});
