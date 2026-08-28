import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import { mapWithConcurrency } from '@server/lib/concurrency';
import { hasDiscoverTmdbId } from '@server/lib/discover/unmapped';
import { ensureMappingLayer } from '@server/lib/mapping/bootstrap';
import mappingService from '@server/lib/mapping/service';
import { tmdbNamespace, type IdRef } from '@server/lib/mapping/types';
import logger from '@server/logger';

const POSTER_BASE = 'https://wsrv.nl/?url=https://simkl.in/posters';

type SimklMediaHint = 'movie' | 'tv' | 'anime' | 'all' | string;

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const scalar = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
};

const numberValue = (value: unknown): number | undefined => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
};

export const tmdbIdFromIds = (
  ids: Record<string, unknown>
): number | undefined => {
  const tmdbId = numberValue(ids.tmdb ?? ids.tmdb_id);
  return hasDiscoverTmdbId(tmdbId) ? tmdbId : undefined;
};

/**
 * Ids Simkl publishes alongside its own. Its `tmdb` field is unreliable for
 * anime seasons (measured 48.9-85.7% wrong), while `imdb`/`tvdb`/`anidb`/
 * `anilist`/`mal` were correct in every traced case.
 */
export interface SimklExternalIds {
  tmdb?: number;
  imdb?: string;
  tvdb?: number;
  anidb?: number;
  anilist?: number;
  mal?: number;
}

const imdbId = (value: unknown): string | undefined => {
  const raw = scalar(value);
  return raw && /^tt\d{4,}$/i.test(raw) ? raw.toLowerCase() : undefined;
};

export const simklExternalIds = (
  ids: Record<string, unknown>
): SimklExternalIds => {
  const tmdb = tmdbIdFromIds(ids);
  const imdb = imdbId(ids.imdb ?? ids.imdb_id);
  const tvdb = numberValue(ids.tvdb ?? ids.tvdb_id);
  const anidb = numberValue(ids.anidb ?? ids.anidb_id);
  const anilist = numberValue(ids.anilist ?? ids.anilist_id);
  const mal = numberValue(ids.mal ?? ids.mal_id);
  return {
    ...(tmdb ? { tmdb } : {}),
    ...(imdb ? { imdb } : {}),
    ...(tvdb ? { tvdb } : {}),
    ...(anidb ? { anidb } : {}),
    ...(anilist ? { anilist } : {}),
    ...(mal ? { mal } : {}),
  };
};

export const simklPosterUrl = (path?: string | null): string | undefined => {
  if (typeof path !== 'string' || !path.trim()) return undefined;
  if (/^https?:\/\//i.test(path)) return path;
  return `${POSTER_BASE}/${path.trim()}_w.webp&q=90`;
};

export const simklRecordId = (
  item: Record<string, unknown>,
  ids: Record<string, unknown> = {}
): string | undefined =>
  scalar(ids.simkl ?? ids.simkl_id ?? item.simkl_id ?? item.id);

const nestedMedia = (
  item: Record<string, unknown>
): Record<string, unknown> | undefined => {
  for (const key of ['show', 'movie', 'anime'] as const) {
    const nested = item[key];
    if (isObject(nested)) return nested;
  }
  return undefined;
};

/** Sync `/sync/all-items` nests title/ids under `show` or `movie`. */
export const unwrapSimklLibraryItem = (
  item: Record<string, unknown>
): Record<string, unknown> => {
  const nested = nestedMedia(item);
  if (!nested) return item;
  return {
    ...item,
    ...nested,
    status: item.status,
    user_rating: item.user_rating ?? nested.user_rating,
    added_to_list_at:
      item.added_to_watchlist_at ?? item.added_to_list_at ?? nested.added_at,
    last_watched_at: item.last_watched_at ?? nested.last_watched_at,
    watched_episodes_count:
      item.watched_episodes_count ?? nested.watched_episodes_count,
    total_episodes_count:
      item.total_episodes_count ?? nested.total_episodes_count,
    anime_type: item.anime_type ?? nested.anime_type,
    ids: isObject(nested.ids) ? nested.ids : item.ids,
  };
};

const bucketHint = (key: string): SimklMediaHint | undefined => {
  if (key === 'movies' || key === 'movie') return 'movie';
  if (key === 'tv' || key === 'shows' || key === 'show') return 'tv';
  if (key === 'anime') return 'anime';
  return undefined;
};

export const catalogEntries = (
  payload: unknown,
  typeHint: SimklMediaHint = 'all'
): { item: Record<string, unknown>; typeHint: SimklMediaHint }[] => {
  if (Array.isArray(payload)) {
    return payload.filter(isObject).map((item) => ({ item, typeHint }));
  }
  if (!isObject(payload)) return [];
  const fromBuckets: {
    item: Record<string, unknown>;
    typeHint: SimklMediaHint;
  }[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (!Array.isArray(value)) continue;
    const hint = bucketHint(key);
    if (!hint) continue;
    if (typeHint !== 'all' && hint !== typeHint) continue;
    for (const item of value) {
      if (isObject(item)) fromBuckets.push({ item, typeHint: hint });
    }
  }
  if (fromBuckets.length) {
    if (typeHint === 'all') {
      return fromBuckets.filter(({ typeHint: hint }) => hint !== 'anime');
    }
    return fromBuckets;
  }
  return Object.values(payload).flatMap((value) =>
    Array.isArray(value)
      ? value.filter(isObject).map((item) => ({ item, typeHint }))
      : []
  );
};

const SYNC_BUCKETS: Record<string, 'movie' | 'show' | 'anime'> = {
  movies: 'movie',
  movie: 'movie',
  shows: 'show',
  show: 'show',
  tv: 'show',
  anime: 'anime',
};

export const syncEntries = (
  payload: unknown,
  fallbackType?: 'movie' | 'show' | 'anime'
): { item: Record<string, unknown>; type: 'movie' | 'show' | 'anime' }[] => {
  if (Array.isArray(payload)) {
    return payload.filter(isObject).flatMap((item) => {
      const type = fallbackType;
      return type ? [{ item: unwrapSimklLibraryItem(item), type }] : [];
    });
  }
  if (!isObject(payload)) return [];
  const entries: {
    item: Record<string, unknown>;
    type: 'movie' | 'show' | 'anime';
  }[] = [];
  for (const [key, value] of Object.entries(payload)) {
    const type = SYNC_BUCKETS[key] ?? fallbackType;
    if (!type || !Array.isArray(value)) continue;
    for (const item of value) {
      if (isObject(item))
        entries.push({ item: unwrapSimklLibraryItem(item), type });
    }
  }
  if (entries.length) return entries;
  if (!fallbackType) return [];
  return catalogEntries(payload).map(({ item }) => ({
    item: unwrapSimklLibraryItem(item),
    type: fallbackType,
  }));
};

const catalogTitle = (item: Record<string, unknown>): string | undefined => {
  if (typeof item.title === 'string' && item.title.trim())
    return item.title.trim();
  const url = typeof item.url === 'string' ? item.url : '';
  const slugFromUrl = url.split('/').filter(Boolean).at(-1);
  const ids = isObject(item.ids) ? item.ids : {};
  const slug = scalar(item.slug ?? ids.slug ?? slugFromUrl);
  return slug ? decodeURIComponent(slug).replace(/-/g, ' ') : undefined;
};

const sourceUrl = (
  item: Record<string, unknown>,
  mediaType: 'movie' | 'tv',
  typeHint: SimklMediaHint,
  id: string,
  ids: Record<string, unknown>
): string => {
  if (typeof item.url === 'string' && item.url.startsWith('http'))
    return item.url;
  if (typeof item.url === 'string' && item.url.startsWith('/'))
    return `https://simkl.com${item.url}`;
  const kind =
    typeHint === 'anime' ? 'anime' : mediaType === 'movie' ? 'movies' : 'tv';
  const slug = scalar(item.slug ?? ids.slug) ?? id;
  return `https://simkl.com/${kind}/${encodeURIComponent(slug)}`;
};

/** Simkl ranks YouTube let's-plays (e.g. RDR2, GTA V) in /tv/best; they are not requestable TV. */
export const isSimklVideoGamePlay = (
  item: Record<string, unknown>
): boolean => {
  const type = String(item.type ?? '').toLowerCase();
  if (type === 'game') return true;
  const network = String(item.network ?? '').toLowerCase();
  if (network === 'youtube') return true;
  const genres = Array.isArray(item.genres) ? item.genres : [];
  return genres.some((genre) =>
    String(genre).toLowerCase().includes('video game')
  );
};

/**
 * A Simkl record paired with the ids needed to resolve it. Media type is read
 * from Simkl's own `type`/`anime_type` and is never inferred later, because the
 * same integer is a valid TMDB movie and TV id 63% of the time.
 */
export interface SimklCandidate {
  item: WatchlistItem;
  ids: SimklExternalIds;
  isAnime: boolean;
}

const isAnimeRecord = (
  item: Record<string, unknown>,
  typeHint: SimklMediaHint
): boolean => {
  if (typeHint === 'anime') return true;
  if (typeof item.anime_type === 'string' && item.anime_type.trim())
    return true;
  return typeof item.url === 'string' && item.url.includes('/anime/');
};

export const toSimklCandidate = (
  item: Record<string, unknown>,
  typeHint: SimklMediaHint,
  keyPrefix: string
): SimklCandidate | null => {
  if (isSimklVideoGamePlay(item)) return null;
  const ids = isObject(item.ids) ? item.ids : {};
  const id = simklRecordId(item, ids);
  const title = catalogTitle(item);
  if (!id || !title) return null;
  const mediaType =
    String(item.type) === 'movie' ||
    String(item.anime_type) === 'movie' ||
    typeHint === 'movie'
      ? 'movie'
      : 'tv';
  const external = simklExternalIds(ids);
  const tmdbId = external.tmdb;
  const poster = simklPosterUrl(
    typeof item.poster === 'string' ? item.poster : undefined
  );
  return {
    ids: external,
    isAnime: isAnimeRecord(item, typeHint),
    item: {
      id: (tmdbId ?? Number(id)) || 0,
      ratingKey: `${keyPrefix}-${id}`,
      ...(hasDiscoverTmdbId(tmdbId) ? { tmdbId } : {}),
      mediaType,
      title,
      source: 'simkl',
      sourceId: id,
      sourceUrl: sourceUrl(item, mediaType, typeHint, id, ids),
      ...(poster ? { image: poster } : {}),
    },
  };
};

export const toCatalogWatchlistItem = (
  item: Record<string, unknown>,
  typeHint: SimklMediaHint,
  keyPrefix: string
): WatchlistItem | null =>
  toSimklCandidate(item, typeHint, keyPrefix)?.item ?? null;

export const catalogCandidates = (
  payloads: unknown[],
  typeHint: SimklMediaHint,
  keyPrefix: string
): SimklCandidate[] => {
  const results: SimklCandidate[] = [];
  const seen = new Set<string>();
  for (const { item, typeHint: hint } of payloads.flatMap((payload) =>
    catalogEntries(payload, typeHint)
  )) {
    const mapped = toSimklCandidate(item, hint, keyPrefix);
    if (!mapped || seen.has(mapped.item.ratingKey)) continue;
    seen.add(mapped.item.ratingKey);
    results.push(mapped);
  }
  return results;
};

export const catalogWatchlistItems = (
  payloads: unknown[],
  typeHint: SimklMediaHint,
  keyPrefix: string
): WatchlistItem[] =>
  catalogCandidates(payloads, typeHint, keyPrefix).map(({ item }) => item);

export const paginateWatchlist = <T>(
  results: T[],
  page: number,
  pageSize = 20
): { results: T[]; hasMore: boolean; page: number } => {
  const start = (Math.max(1, page) - 1) * pageSize;
  return {
    page: Math.max(1, page),
    hasMore: start + pageSize < results.length,
    results: results.slice(start, start + pageSize),
  };
};

export const simklDetailKind = (
  item: WatchlistItem
): 'movies' | 'tv' | 'anime' => {
  if (item.sourceUrl?.includes('/anime/')) return 'anime';
  return item.mediaType === 'movie' ? 'movies' : 'tv';
};

export type SimklDetailLoader = (
  kind: 'movies' | 'tv' | 'anime',
  simklId: string
) => Promise<Record<string, unknown>>;

/**
 * Simkl list payloads frequently carry only `simkl_id` + `slug`. The detail
 * endpoint is Cloudflare edge-cached and parallel-safe, so it is fetched when
 * ids are missing, and always for anime when IMDB/TVDB are absent: those are
 * the cheap `/find` path, and without them we need anilist/anidb/mal for the
 * mapping-layer fallthrough.
 */
const needsSimklDetail = (candidate: SimklCandidate): boolean => {
  if (!candidate.item.sourceId) return false;
  if (candidate.isAnime) return !candidate.ids.imdb && !candidate.ids.tvdb;
  return !candidate.ids.tmdb && !candidate.ids.imdb && !candidate.ids.tvdb;
};

export async function hydrateSimklCandidates(
  candidates: SimklCandidate[],
  loadTitle: SimklDetailLoader
): Promise<SimklCandidate[]> {
  const mapped = await mapWithConcurrency(candidates, 4, async (candidate) => {
    if (!needsSimklDetail(candidate)) return candidate;
    const sourceId = candidate.item.sourceId as string;
    try {
      const detail = await loadTitle(simklDetailKind(candidate.item), sourceId);
      if (isSimklVideoGamePlay(detail)) return null;
      const ids = isObject(detail.ids) ? detail.ids : {};
      return {
        ...candidate,
        ids: { ...candidate.ids, ...simklExternalIds(ids) },
      };
    } catch {
      return candidate;
    }
  });
  return mapped.filter((entry): entry is SimklCandidate => entry !== null);
}

export interface SimklTmdbResolution {
  tmdbId?: number;
  confidence: number;
  sourceKey: string;
  /** Set when a candidate was found but could not be corroborated. */
  ambiguous?: boolean;
  /**
   * Declared media type after resolution. Anime films often arrive typed as
   * `tv` from the anime catalog; mapping/IMDB may prove they are movies.
   */
  mediaType?: 'movie' | 'tv';
}

export interface SimklTmdbResolvers {
  /**
   * TMDB `/find`, scoped to the declared media type. `tvdb_id` is documented as
   * unsupported for movies, so callers must return an empty list there.
   */
  findByExternalId: (
    source: 'imdb' | 'tvdb',
    externalId: string,
    mediaType: 'movie' | 'tv'
  ) => Promise<number[]>;
  /**
   * Existence check in the declared namespace only. May reject a candidate,
   * never choose between two: `/movie/{id}` returning 200 is not evidence that
   * the id denotes that movie.
   */
  confirm: (mediaType: 'movie' | 'tv', tmdbId: number) => Promise<boolean>;
}

const UNRESOLVED: SimklTmdbResolution = {
  confidence: 0,
  sourceKey: 'simkl:unresolved',
};

/**
 * Resolve one Simkl record to a TMDB id without ever inferring media type.
 *
 * Simkl's `imdb`/`tvdb` ids resolve through TMDB `/find` and were correct in
 * every traced case; its `tmdb` field is only accepted when a second namespace
 * agrees, or (for non-anime, where it measured reliable) when it exists in the
 * declared namespace. Anime records with an uncorroborated `tmdb` are reported
 * as ambiguous so they render an honest unmapped tile instead of the wrong
 * poster.
 */
export async function resolveSimklTmdbId(
  candidate: SimklCandidate,
  resolvers: SimklTmdbResolvers
): Promise<SimklTmdbResolution> {
  const declaredType = candidate.item.mediaType;
  const { imdb, tvdb, tmdb } = candidate.ids;

  const corroborating: {
    sourceKey: string;
    ids: number[];
    mediaType: 'movie' | 'tv';
  }[] = [];
  if (imdb) {
    const preferredIds = await resolvers.findByExternalId(
      'imdb',
      imdb,
      declaredType
    );
    corroborating.push({
      sourceKey: 'tmdb-find:imdb',
      mediaType: declaredType,
      ids: preferredIds,
    });
    // Anime "best" lists dump theatrical films as tv. Only probe movies when
    // the declared namespace found nothing — otherwise flagship TV shows would
    // keep hitting /find twice for no reason.
    if (
      candidate.isAnime &&
      declaredType === 'tv' &&
      preferredIds.length === 0
    ) {
      const movieIds = await resolvers.findByExternalId('imdb', imdb, 'movie');
      if (movieIds.length) {
        corroborating.push({
          sourceKey: 'tmdb-find:imdb:movie',
          mediaType: 'movie',
          ids: movieIds,
        });
      }
    }
  }
  if (tvdb && declaredType === 'tv') {
    corroborating.push({
      sourceKey: 'tmdb-find:tvdb',
      mediaType: 'tv',
      ids: await resolvers.findByExternalId('tvdb', String(tvdb), 'tv'),
    });
  }

  const agreed = corroborating.find(({ ids }) => tmdb && ids.includes(tmdb));
  if (agreed) {
    return {
      tmdbId: tmdb,
      confidence: 95,
      sourceKey: `simkl:tmdb+${agreed.sourceKey}`,
      mediaType: agreed.mediaType,
    };
  }

  const found = corroborating.find(({ ids }) => ids.length === 1);
  if (found) {
    return {
      tmdbId: found.ids[0],
      confidence: 80,
      sourceKey: found.sourceKey,
      mediaType: found.mediaType,
    };
  }

  const multiple = corroborating.find(({ ids }) => ids.length > 1);
  if (multiple) {
    return { ...UNRESOLVED, ambiguous: true, sourceKey: multiple.sourceKey };
  }

  // TMDB `/find` only speaks IMDB/TVDB. Everything else — including brand-new
  // seasonal anime that Simkl has anilist/anidb/mal for but no IMDB yet — goes
  // through the mapping layer, which is what the packs and live resolvers are for.
  const mapped = await resolveViaMappingLayer(candidate, resolvers);
  if (mapped) return mapped;

  if (!tmdb) return UNRESOLVED;

  if (candidate.isAnime) {
    return { ...UNRESOLVED, ambiguous: true, sourceKey: 'simkl:tmdb' };
  }

  return (await resolvers.confirm(declaredType, tmdb))
    ? {
        tmdbId: tmdb,
        confidence: 60,
        sourceKey: 'simkl:tmdb',
        mediaType: declaredType,
      }
    : { ...UNRESOLVED, ambiguous: true, sourceKey: 'simkl:tmdb' };
}

/** Ids Simkl got right that the mapping graph and live resolvers already speak. */
const mappingRefs = (candidate: SimklCandidate): IdRef[] => {
  const refs: IdRef[] = [];
  const { anilist, anidb, mal } = candidate.ids;
  if (anilist) refs.push({ ns: 'anilist', id: String(anilist) });
  if (anidb) refs.push({ ns: 'anidb', id: String(anidb) });
  if (mal) refs.push({ ns: 'mal', id: String(mal) });
  if (candidate.item.sourceId) {
    refs.push({ ns: 'simkl', id: String(candidate.item.sourceId) });
  }
  return refs;
};

async function resolveViaMappingLayer(
  candidate: SimklCandidate,
  resolvers: SimklTmdbResolvers
): Promise<SimklTmdbResolution | undefined> {
  const refs = mappingRefs(candidate);
  if (!refs.length) return undefined;

  ensureMappingLayer();
  const declaredType = candidate.item.mediaType;
  // Anime theatrical films show up on anime/best as mediaType=tv. Prefer the
  // declared namespace, then the opposite — existence confirm still gates.
  const mediaTypes: ('movie' | 'tv')[] =
    candidate.isAnime && declaredType === 'tv'
      ? ['tv', 'movie']
      : candidate.isAnime && declaredType === 'movie'
        ? ['movie', 'tv']
        : [declaredType];

  for (const mediaType of mediaTypes) {
    const target = tmdbNamespace(mediaType);
    for (const ref of refs) {
      try {
        const resolution = await mappingService.resolve(ref, target, {
          silent: true,
          title: candidate.item.title,
          mediaType,
          discoverSource: 'simkl',
        });
        const tmdbId = Number(resolution.target?.id);
        if (!(tmdbId > 0)) continue;
        // Existence may only reject — same integer in the other namespace is how
        // wrong posters happen.
        if (!(await resolvers.confirm(mediaType, tmdbId))) continue;
        return {
          tmdbId,
          confidence: resolution.confidence,
          sourceKey: resolution.sourceKey || `mapping:${ref.ns}`,
          mediaType,
        };
      } catch (error) {
        logger.debug('Simkl mapping-layer fallthrough failed', {
          label: 'Mapping',
          from: `${ref.ns}:${ref.id}`,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return undefined;
}

export interface ResolvedSimklItem {
  item: WatchlistItem;
  resolution: SimklTmdbResolution;
  candidate: SimklCandidate;
}

export async function resolveSimklCandidates(
  candidates: SimklCandidate[],
  resolvers: SimklTmdbResolvers
): Promise<ResolvedSimklItem[]> {
  return mapWithConcurrency(candidates, 2, async (candidate) => {
    let resolution: SimklTmdbResolution;
    try {
      resolution = await resolveSimklTmdbId(candidate, resolvers);
    } catch {
      resolution = UNRESOLVED;
    }
    const tmdbId = resolution.tmdbId;
    const mediaType = resolution.mediaType ?? candidate.item.mediaType;
    const item: WatchlistItem = hasDiscoverTmdbId(tmdbId)
      ? { ...candidate.item, tmdbId, id: tmdbId, mediaType }
      : {
          ...candidate.item,
          id: Number(candidate.item.sourceId) || 0,
          tmdbId: undefined,
        };
    return { item, resolution, candidate };
  });
}
