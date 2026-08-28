/**
 * Identity namespaces for the mapping graph.
 *
 * `tmdb_movie` and `tmdb_show` are separate namespaces on purpose: the same
 * integer is a valid id in both catalogues for two unrelated titles 63% of the
 * time (sampled 2026-08-28), so media type is part of an id's identity and can
 * never be inferred from an endpoint returning 200.
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
  'kitsu',
  'simkl',
  'trakt',
  'livechart',
  'animeplanet',
  'anisearch',
] as const;

export type Namespace = (typeof NAMESPACES)[number];

export const isNamespace = (value: unknown): value is Namespace =>
  typeof value === 'string' &&
  (NAMESPACES as readonly string[]).includes(value);

export type ClusterKind = 'series' | 'movie';

export interface IdRef {
  ns: Namespace;
  id: string;
  season?: number;
  episode?: number;
}

export interface MappingCandidate {
  target: IdRef;
  confidence: number;
  sourceKey: string;
  /** Intermediate hops taken to reach the target, for provenance display. */
  via?: IdRef[];
}

export type ResolverKind = 'override' | 'graph' | 'pack' | 'live' | 'heuristic';

/**
 * Descriptive hints carried alongside an id. Only the heuristic layer may act
 * on them; id-based resolvers must ignore them so a wrong title can never
 * change a corroborated answer.
 */
export interface ResolverContext {
  title?: string;
  year?: number;
  mediaType?: 'movie' | 'tv';
  episodeCount?: number;
  discoverSource?: string;
}

export interface MappingResolver {
  key: string;
  kind: ResolverKind;
  trust: number;
  supports(from: IdRef, to: Namespace): boolean;
  resolve(
    from: IdRef,
    to: Namespace,
    context?: ResolverContext
  ): Promise<MappingCandidate[]>;
}

export const TMDB_NAMESPACES = {
  movie: 'tmdb_movie',
  tv: 'tmdb_show',
} as const satisfies Record<'movie' | 'tv', Namespace>;

export const tmdbNamespace = (mediaType: 'movie' | 'tv'): Namespace =>
  TMDB_NAMESPACES[mediaType];

export const tmdbMediaType = (ns: Namespace): 'movie' | 'tv' | undefined => {
  if (ns === 'tmdb_movie') return 'movie';
  if (ns === 'tmdb_show') return 'tv';
  return undefined;
};

/**
 * Sentinel for "not season-scoped". Stored instead of NULL so unique indexes
 * collapse duplicates: Postgres treats NULLs in a unique index as distinct.
 */
export const NO_SEASON = -1;

export const seasonColumn = (season?: number | null): number =>
  typeof season === 'number' && Number.isInteger(season) && season >= 0
    ? season
    : NO_SEASON;

export const seasonValue = (column: number): number | undefined =>
  column === NO_SEASON ? undefined : column;

export const refKey = (ref: IdRef): string =>
  `${ref.ns}:${ref.id}${ref.season === undefined ? '' : `:s${ref.season}`}`;

/**
 * Identity of the work, ignoring season. Season-scoped anibridge edges for the
 * same show (`tmdb_show:82684:s1` … `:s4`) must not count as four disagreeing
 * answers when a discover tile asks "which show is this".
 */
export const workKey = (ref: IdRef): string => `${ref.ns}:${ref.id}`;

export const clusterKindForNamespace = (
  ns: Namespace
): ClusterKind | undefined => {
  if (ns === 'tmdb_movie' || ns === 'tvdb_movie') return 'movie';
  if (ns === 'tmdb_show' || ns === 'tvdb_show') return 'series';
  return undefined;
};
