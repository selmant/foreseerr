/**
 * The filters an AniList list view reads, as anilist.co's list sidebar
 * offers them. The backend applies them to the whole list before paging.
 */
import type { ListSortOption } from '@app/components/Discover/listSort';
import { defaultOrderForKind } from '@app/components/Discover/listSort';

export const anilistFormats = [
  'TV',
  'TV_SHORT',
  'MOVIE',
  'SPECIAL',
  'OVA',
  'ONA',
  'MUSIC',
] as const;

export const anilistAiringStatuses = [
  'RELEASING',
  'FINISHED',
  'NOT_YET_RELEASED',
  'CANCELLED',
  'HIATUS',
] as const;

export const anilistCountries = ['JP', 'KR', 'CN', 'TW'] as const;

/** AniList's genre list, without the adult-only one. */
export const anilistGenres = [
  'Action',
  'Adventure',
  'Comedy',
  'Drama',
  'Ecchi',
  'Fantasy',
  'Horror',
  'Mahou Shoujo',
  'Mecha',
  'Music',
  'Mystery',
  'Psychological',
  'Romance',
  'Sci-Fi',
  'Slice of Life',
  'Sports',
  'Supernatural',
  'Thriller',
] as const;

/** anilist.co's list sorts, with how the menu groups them. */
export const anilistSortOptions = [
  { value: 'createdAt', kind: 'date', group: 'list' },
  { value: 'updatedAt', kind: 'date', group: 'list' },
  { value: 'title', kind: 'alpha', group: 'list' },
  { value: 'releaseDate', kind: 'date', group: 'release' },
  { value: 'score', kind: 'number', group: 'ratings' },
  { value: 'averageScore', kind: 'number', group: 'ratings' },
  { value: 'popularity', kind: 'number', group: 'popularity' },
  { value: 'progress', kind: 'number', group: 'details' },
] as const satisfies readonly ListSortOption<string>[];

export type AnilistSort = (typeof anilistSortOptions)[number]['value'];

export const anilistSorts: readonly AnilistSort[] = anilistSortOptions.map(
  (o) => o.value
);

export const anilistSortOption = (sort: AnilistSort) =>
  anilistSortOptions.find(
    (o) => o.value === sort
  ) as ListSortOption<AnilistSort>;

/** Titles read A→Z; every score, count, and date high→low. */
export const defaultAnilistOrder = (sort: AnilistSort): 'asc' | 'desc' =>
  defaultOrderForKind(anilistSortOption(sort).kind);

/** The release-year slider's range: 1940 through next year. */
export const anilistYearRange = (now = new Date()) => ({
  min: 1940,
  max: now.getFullYear() + 1,
});

/**
 * Score ranges on AniList's 0–100 scale, checked by Foreseerr: the
 * community average and the score the list's owner gave.
 */
export const anilistScoreFilters = ['averageScore', 'myScore'] as const;

/** Filters in the panel (the bar holds the search and the sort). */
export const anilistPanelKeys = [
  'format',
  'airingStatus',
  'genres',
  'country',
  'yearFrom',
  'yearTo',
  'averageScoreMin',
  'averageScoreMax',
  'myScoreMin',
  'myScoreMax',
] as const;

/** Every key the list routes read for filtering, besides `page`. */
export const anilistQueryKeys = [
  'search',
  ...anilistPanelKeys,
  'sort',
  'order',
  'hideUnmapped',
] as const;

type RouteQuery = Record<string, string | string[] | undefined>;

const text = (value: RouteQuery[string]) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** The route query's AniList filters, as request options. */
export const prepareAnilistOptions = (query: RouteQuery) => {
  const options: Record<string, string> = {};
  for (const key of anilistQueryKeys) {
    const value = text(query[key]);
    if (value !== undefined) options[key] = value;
  }
  return options;
};

/**
 * How many panel filters are set: the Filters button's badge. The bar's
 * search is visible, so it is not counted; a range counts once.
 */
export const countAnilistFilters = (query: RouteQuery) => {
  let count = 0;
  for (const key of ['format', 'airingStatus', 'genres', 'country'] as const) {
    if (text(query[key])) count += 1;
  }
  for (const range of ['year', ...anilistScoreFilters]) {
    const [low, high] =
      range === 'year'
        ? ['yearFrom', 'yearTo']
        : [`${range}Min`, `${range}Max`];
    if (text(query[low]) || text(query[high])) count += 1;
  }
  // `false` is what "Clear" writes to keep saved defaults off.
  if (query.hideUnmapped === 'true') count += 1;
  return count;
};

/** Whether anything narrows the list: a panel filter or the search. */
export const hasAnilistFilters = (query: RouteQuery) =>
  countAnilistFilters(query) > 0 || text(query.search) !== undefined;

/**
 * The route update that clears the panel (and the search, from an empty
 * result). `hideUnmapped=false` keeps saved defaults from coming back.
 */
export const anilistClearParams = ({ search = false } = {}) => ({
  ...Object.fromEntries(anilistPanelKeys.map((k) => [k, undefined])),
  ...(search ? { search: undefined } : {}),
  hideUnmapped: 'false',
});
