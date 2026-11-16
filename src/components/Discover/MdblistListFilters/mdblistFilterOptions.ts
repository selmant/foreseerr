/**
 * The filters and sorts MDBList applies to a list's items itself
 * (`/lists/{id}/items`), as the route's query keys. Kept in one place so the
 * filter bar, the panel, and the request agree.
 */

/** MDBList's sort keys, in the order mdblist.com lists them. */
export const mdblistSorts = [
  'rank',
  'usort',
  'score',
  'score_average',
  'released',
  'releasedigital',
  'added',
  'imdbrating',
  'imdbvotes',
  'imdbpopular',
  'tmdbpopular',
  'rogerebert',
  'rtomatoes',
  'rtaudience',
  'metacritic',
  'myanimelist',
  'letterrating',
  'lettervotes',
  'last_air_date',
  'budget',
  'revenue',
  'runtime',
  'title',
  'sort_title',
] as const;

export type MdblistSort = (typeof mdblistSorts)[number];

/** Rank and names read naturally A→Z; every score, date, and count high→low. */
export const defaultMdblistOrder = (sort: MdblistSort): 'asc' | 'desc' =>
  sort === 'rank' ||
  sort === 'usort' ||
  sort === 'title' ||
  sort === 'sort_title'
    ? 'asc'
    : 'desc';

/** MDBList's rating filters, on its normalized 0–100 scale. */
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

/** Filters shown in the panel (the bar holds media type and sort). */
export const mdblistPanelKeys = [
  'title',
  'genres',
  'genreMode',
  'releasedFrom',
  'releasedTo',
  ...mdblistRatingFilters.flatMap((r) => [`${r}Min`, `${r}Max`]),
] as const;

/** Every key the list route reads, besides `url` and `page`. */
export const mdblistQueryKeys = [
  'mediaType',
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

/** How many panel filters are set; `genreMode` alone doesn't count. */
export const countMdblistFilters = (query: RouteQuery) => {
  let count = 0;
  if (text(query.title)) count += 1;
  if (text(query.genres)) count += 1;
  if (text(query.releasedFrom) || text(query.releasedTo)) count += 1;
  for (const rating of mdblistRatingFilters) {
    if (text(query[`${rating}Min`]) || text(query[`${rating}Max`])) count += 1;
  }
  if (query.hideUnmapped === 'true' || query.hideUnmapped === 'false') {
    count += 1;
  }
  return count;
};
