import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import { mapWithConcurrency } from '@server/lib/concurrency';
import { hasDiscoverTmdbId } from '@server/lib/discover/unmapped';

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

/** Simkl ranks YouTube let's-plays (e.g. RDR2) in /tv/best; they are not requestable TV. */
export const isSimklVideoGamePlay = (
  item: Record<string, unknown>
): boolean => {
  const type = String(item.type ?? '').toLowerCase();
  if (type === 'game') return true;
  const genres = Array.isArray(item.genres) ? item.genres : [];
  return genres.some((genre) =>
    String(genre).toLowerCase().includes('video game')
  );
};

export const toCatalogWatchlistItem = (
  item: Record<string, unknown>,
  typeHint: SimklMediaHint,
  keyPrefix: string
): WatchlistItem | null => {
  if (isSimklVideoGamePlay(item)) return null;
  const ids = isObject(item.ids) ? item.ids : {};
  const id = simklRecordId(item, ids);
  const title = catalogTitle(item);
  if (!id || !title) return null;
  const mediaType =
    String(item.type) === 'movie' || typeHint === 'movie' ? 'movie' : 'tv';
  const tmdbId = tmdbIdFromIds(ids);
  const poster = simklPosterUrl(
    typeof item.poster === 'string' ? item.poster : undefined
  );
  return {
    id: (tmdbId ?? Number(id)) || 0,
    ratingKey: `${keyPrefix}-${id}`,
    ...(hasDiscoverTmdbId(tmdbId) ? { tmdbId } : {}),
    mediaType,
    title,
    source: 'simkl',
    sourceId: id,
    sourceUrl: sourceUrl(item, mediaType, typeHint, id, ids),
    ...(poster ? { image: poster } : {}),
  };
};

export const catalogWatchlistItems = (
  payloads: unknown[],
  typeHint: SimklMediaHint,
  keyPrefix: string
): WatchlistItem[] => {
  const results: WatchlistItem[] = [];
  const seen = new Set<string>();
  for (const { item, typeHint: hint } of payloads.flatMap((payload) =>
    catalogEntries(payload, typeHint)
  )) {
    const mapped = toCatalogWatchlistItem(item, hint, keyPrefix);
    if (!mapped || seen.has(mapped.ratingKey)) continue;
    seen.add(mapped.ratingKey);
    results.push(mapped);
  }
  return results;
};

export const paginateWatchlist = (
  results: WatchlistItem[],
  page: number,
  pageSize = 20
): { results: WatchlistItem[]; hasMore: boolean; page: number } => {
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

/** Cached Simkl detail endpoints expose ids.tmdb when list payloads omit it. */
export async function fillMissingTmdbIds(
  items: WatchlistItem[],
  loadTitle: (
    kind: 'movies' | 'tv' | 'anime',
    simklId: string
  ) => Promise<Record<string, unknown>>
): Promise<WatchlistItem[]> {
  const mapped = await mapWithConcurrency(items, 4, async (item) => {
    if (!item.sourceId) return item;
    if (hasDiscoverTmdbId(item.tmdbId)) return item;
    try {
      const detail = await loadTitle(simklDetailKind(item), item.sourceId);
      if (isSimklVideoGamePlay(detail)) return null;
      const ids = isObject(detail.ids) ? detail.ids : {};
      const tmdbId = tmdbIdFromIds(ids);
      if (!hasDiscoverTmdbId(tmdbId)) return item;
      return { ...item, tmdbId, id: tmdbId };
    } catch {
      return item;
    }
  });
  return mapped.filter((item): item is WatchlistItem => item !== null);
}

const normalizeTitle = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, '');

export const simklTitlesMatch = (left: string, right: string): boolean => {
  const a = normalizeTitle(left);
  const b = normalizeTitle(right);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
};

/** Prefer the Simkl hint, then the other TMDB catalog, so anime films map as movies. */
export async function assignWorkingTmdbMediaType(
  items: WatchlistItem[],
  probe: (mediaType: 'movie' | 'tv', tmdbId: number) => Promise<string | false>
): Promise<WatchlistItem[]> {
  return mapWithConcurrency(items, 2, async (item) => {
    if (!hasDiscoverTmdbId(item.tmdbId)) return item;
    const tmdbId = item.tmdbId;
    const order: ('movie' | 'tv')[] =
      item.mediaType === 'movie' ? ['movie', 'tv'] : ['tv', 'movie'];
    for (const mediaType of order) {
      const title = await probe(mediaType, tmdbId);
      if (title && simklTitlesMatch(item.title, title)) {
        return { ...item, mediaType, id: tmdbId };
      }
    }
    return {
      ...item,
      id: Number(item.sourceId) || 0,
      tmdbId: undefined,
    };
  });
}
