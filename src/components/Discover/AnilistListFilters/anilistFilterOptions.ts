/**
 * The filters an AniList list view reads, as anilist.co's list sidebar
 * offers them. The backend applies them to the whole list before paging.
 */

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

/** anilist.co's list sorts. */
export const anilistSorts = [
  'score',
  'title',
  'progress',
  'updatedAt',
  'createdAt',
  'releaseDate',
  'averageScore',
  'popularity',
] as const;

export type AnilistSort = (typeof anilistSorts)[number];

/** Titles read A→Z; every score, count, and date high→low. */
export const defaultAnilistOrder = (sort: AnilistSort): 'asc' | 'desc' =>
  sort === 'title' ? 'asc' : 'desc';

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

/** Filters shown in the panel or the search box (the bar holds the sort). */
export const anilistPanelKeys = [
  'search',
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

/** How many filters are set (search included, sort not; a range once). */
export const countAnilistFilters = (query: RouteQuery) => {
  let count = 0;
  for (const key of [
    'search',
    'format',
    'airingStatus',
    'genres',
    'country',
  ] as const) {
    if (text(query[key])) count += 1;
  }
  for (const range of ['year', ...anilistScoreFilters]) {
    const [low, high] =
      range === 'year'
        ? ['yearFrom', 'yearTo']
        : [`${range}Min`, `${range}Max`];
    if (text(query[low]) || text(query[high])) count += 1;
  }
  if (query.hideUnmapped === 'true' || query.hideUnmapped === 'false') {
    count += 1;
  }
  return count;
};
