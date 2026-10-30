const CommonSortOptionsIterable = [
  'popularity.desc',
  'popularity.asc',
  'vote_average.desc',
  'vote_average.asc',
  'vote_count.desc',
  'vote_count.asc',
] as const;

export const MovieSortOptionsIterable = [
  ...CommonSortOptionsIterable,
  'release_date.desc',
  'release_date.asc',
  'revenue.desc',
  'revenue.asc',
  'primary_release_date.desc',
  'primary_release_date.asc',
  'original_title.desc',
  'original_title.asc',
] as const;

export const TvSortOptionsIterable = [
  ...CommonSortOptionsIterable,
  'first_air_date.desc',
  'first_air_date.asc',
  'original_name.desc',
  'original_name.asc',
] as const;

export type MovieSortOptions = (typeof MovieSortOptionsIterable)[number];

export type TvSortOptions = (typeof TvSortOptionsIterable)[number];
