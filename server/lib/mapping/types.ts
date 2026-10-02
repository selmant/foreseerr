/**
 * Id namespaces the mapping layer speaks.
 *
 * `tmdb_movie` and `tmdb_show` are separate namespaces on purpose: the same
 * integer is a valid id in both catalogues for two unrelated titles 63% of the
 * time (sampled 2026-08-28), so media type is part of an id's identity and can
 * never be inferred from an endpoint returning 200.
 *
 * `simkl` and `trakt` only ever identify an item in the unmapped list and in
 * manual corrections; no dataset is keyed by them.
 */
export const NAMESPACES = [
  'tmdb_movie',
  'tmdb_show',
  'tvdb_movie',
  'tvdb_show',
  'imdb',
  'anidb',
  'anilist',
  'mal',
  'simkl',
  'trakt',
] as const;

export type Namespace = (typeof NAMESPACES)[number];

export const isNamespace = (value: unknown): value is Namespace =>
  typeof value === 'string' &&
  (NAMESPACES as readonly string[]).includes(value);

export type MediaType = 'movie' | 'tv';

export interface IdRef {
  ns: Namespace;
  id: string;
  season?: number;
}

/** Where an answer came from, in resolution order. */
export type MappingOrigin =
  | 'manual'
  | 'dataset'
  | 'tmdb-find'
  | 'title'
  | 'prequel';

export const tmdbNamespace = (mediaType: MediaType): Namespace =>
  mediaType === 'movie' ? 'tmdb_movie' : 'tmdb_show';

export const tmdbMediaType = (ns: string): MediaType | undefined => {
  if (ns === 'tmdb_movie') return 'movie';
  if (ns === 'tmdb_show') return 'tv';
  return undefined;
};

export const refKey = (ref: IdRef): string =>
  `${ref.ns}:${ref.id}${ref.season === undefined ? '' : `:s${ref.season}`}`;

/** Edge scope for a season: datasets write `s1`, `s0`. */
export const seasonScope = (season: number): string => `s${season}`;

/** The season a scope names, or undefined for an unscoped or AniDB scope. */
export const scopeSeason = (scope: string): number | undefined => {
  const match = scope.match(/^s(\d+)$/);
  return match ? Number(match[1]) : undefined;
};
