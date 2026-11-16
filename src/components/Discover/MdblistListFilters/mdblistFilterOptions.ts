/**
 * The filters and sorts MDBList applies to a list's items itself
 * (`/lists/{id}/items`), as the route's query keys. Kept in one place so the
 * filter bar, the panel, and the request agree.
 */
import type { ListSortOption } from '@app/components/Discover/listSort';
import { defaultOrderForKind } from '@app/components/Discover/listSort';

/**
 * MDBList's sort keys with how the menu shows them. `rank` is the list's
 * own order (the menu's "List Order" reversed), and `usort` / `sort_title`
 * duplicate other entries; links that use them keep working.
 */
export const mdblistSortOptions = [
  { value: 'rank', kind: 'position', group: 'list', hidden: true },
  { value: 'usort', kind: 'position', group: 'list', hidden: true },
  { value: 'added', kind: 'date', group: 'list' },
  { value: 'title', kind: 'alpha', group: 'list' },
  { value: 'sort_title', kind: 'alpha', group: 'list', hidden: true },
  { value: 'released', kind: 'date', group: 'release' },
  { value: 'releasedigital', kind: 'date', group: 'release', only: 'movie' },
  { value: 'last_air_date', kind: 'date', group: 'release', only: 'tv' },
  { value: 'score', kind: 'number', group: 'ratings' },
  { value: 'score_average', kind: 'number', group: 'ratings' },
  { value: 'imdbrating', kind: 'number', group: 'ratings' },
  { value: 'rtomatoes', kind: 'number', group: 'ratings' },
  { value: 'rtaudience', kind: 'number', group: 'ratings' },
  { value: 'metacritic', kind: 'number', group: 'ratings' },
  { value: 'letterrating', kind: 'number', group: 'ratings' },
  { value: 'myanimelist', kind: 'number', group: 'ratings' },
  { value: 'rogerebert', kind: 'number', group: 'ratings', only: 'movie' },
  { value: 'imdbvotes', kind: 'number', group: 'popularity' },
  { value: 'imdbpopular', kind: 'number', group: 'popularity' },
  { value: 'tmdbpopular', kind: 'number', group: 'popularity' },
  { value: 'lettervotes', kind: 'number', group: 'popularity' },
  { value: 'runtime', kind: 'number', group: 'details' },
  { value: 'budget', kind: 'number', group: 'details', only: 'movie' },
  { value: 'revenue', kind: 'number', group: 'details', only: 'movie' },
] as const satisfies readonly ListSortOption<string>[];

export type MdblistSort = (typeof mdblistSortOptions)[number]['value'];

/** Every sort key the route accepts. */
export const mdblistSorts: readonly MdblistSort[] = mdblistSortOptions.map(
  (o) => o.value
);

export const mdblistSortOption = (sort: MdblistSort) =>
  mdblistSortOptions.find(
    (o) => o.value === sort
  ) as ListSortOption<MdblistSort>;

/** Positions and names read top-down / A→Z; scores, dates, counts high→low. */
export const defaultMdblistOrder = (sort: MdblistSort): 'asc' | 'desc' =>
  defaultOrderForKind(mdblistSortOption(sort).kind);

/** MDBList's rating filters; the route takes MDBList's 0–100 scores. */
export const mdblistRatingFilters = [
  'score',
  'imdbRating',
  'tmdbRating',
  'metacritic',
  'rtCritics',
  'rtAudience',
  'letterboxd',
  'mal',
] as const;

export type MdblistRatingFilter = (typeof mdblistRatingFilters)[number];

/** Shown up front; the rest sit behind "More ratings". */
export const mdblistPrimaryRatings: readonly MdblistRatingFilter[] = [
  'score',
  'imdbRating',
  'rtCritics',
];

/**
 * Each source on the scale its site uses. MDBList's 0–100 score is the
 * native value times `factor` (IMDb 9.3 → 93, Letterboxd 4.6 → 92).
 */
export const mdblistRatingScales: Record<
  MdblistRatingFilter,
  { max: number; step: number; factor: number }
> = {
  score: { max: 100, step: 1, factor: 1 },
  imdbRating: { max: 10, step: 0.1, factor: 10 },
  tmdbRating: { max: 100, step: 1, factor: 1 },
  metacritic: { max: 100, step: 1, factor: 1 },
  rtCritics: { max: 100, step: 1, factor: 1 },
  rtAudience: { max: 100, step: 1, factor: 1 },
  letterboxd: { max: 5, step: 0.1, factor: 20 },
  mal: { max: 10, step: 0.1, factor: 10 },
};

/** A route score (0–100) on the source's own scale. */
export const ratingToDisplay = (
  rating: MdblistRatingFilter,
  score: number
): number => {
  const { factor, step } = mdblistRatingScales[rating];
  const value = score / factor;
  return step < 1 ? Math.round(value * 10) / 10 : value;
};

/** A value on the source's own scale as the route's 0–100 score. */
export const ratingToQuery = (
  rating: MdblistRatingFilter,
  value: number
): number =>
  Math.min(
    100,
    Math.max(0, Math.round(value * mdblistRatingScales[rating].factor))
  );

/** The release-year slider's range: 1900 through next year. */
export const mdblistYearRange = (now = new Date()) => ({
  min: 1900,
  max: now.getFullYear() + 1,
});

/** The year of a `releasedFrom` / `releasedTo` date. */
export const yearOfDate = (value: unknown): number | undefined => {
  const match =
    typeof value === 'string' ? /^\s*(\d{4})(?:-|$)/.exec(value) : null;
  return match ? Number(match[1]) : undefined;
};

/** A year range as the route's release dates (whole years). */
export const releaseDatesForYears = (from?: number, to?: number) => ({
  releasedFrom: from === undefined ? undefined : `${from}-01-01`,
  releasedTo: to === undefined ? undefined : `${to}-12-31`,
});

/** Filters in the panel (the bar holds the search and the sort). */
export const mdblistPanelKeys = [
  'mediaType',
  'genres',
  'genreMode',
  'releasedFrom',
  'releasedTo',
  ...mdblistRatingFilters.flatMap((r) => [`${r}Min`, `${r}Max`]),
] as const;

/** Every key the list route reads, besides `url` and `page`. */
export const mdblistQueryKeys = [
  'title',
  'sort',
  'order',
  ...mdblistPanelKeys,
  'hideUnmapped',
] as const;

type RouteQuery = Record<string, string | string[] | undefined>;

const text = (value: RouteQuery[string]) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** The route query's MDBList filters, as request options. */
export const prepareMdblistOptions = (query: RouteQuery) => {
  const options: Record<string, string> = {};
  for (const key of mdblistQueryKeys) {
    const value = text(query[key]);
    if (value !== undefined) options[key] = value;
  }
  // `genreMode` only means something with genres picked.
  if (!options.genres) delete options.genreMode;
  return options;
};

/**
 * How many panel filters are set: the Filters button's badge. The search
 * sits in the bar, visible, so it is not counted; `genreMode` alone isn't.
 */
export const countMdblistFilters = (query: RouteQuery) => {
  let count = 0;
  if (text(query.mediaType)) count += 1;
  if (text(query.genres)) count += 1;
  if (text(query.releasedFrom) || text(query.releasedTo)) count += 1;
  for (const rating of mdblistRatingFilters) {
    if (text(query[`${rating}Min`]) || text(query[`${rating}Max`])) count += 1;
  }
  // `false` is what "Clear" writes to keep saved defaults off.
  if (query.hideUnmapped === 'true') count += 1;
  return count;
};

/** Whether anything narrows the list: a panel filter or the search. */
export const hasMdblistFilters = (query: RouteQuery) =>
  countMdblistFilters(query) > 0 || text(query.title) !== undefined;

/**
 * The route update that clears the panel (and the search, from an empty
 * result). `hideUnmapped=false` keeps saved defaults from coming back.
 */
export const mdblistClearParams = ({ search = false } = {}) => ({
  ...Object.fromEntries(mdblistPanelKeys.map((k) => [k, undefined])),
  ...(search ? { title: undefined } : {}),
  hideUnmapped: 'false',
});
