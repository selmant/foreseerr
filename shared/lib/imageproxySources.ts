export const IMAGE_CACHE_IDLE_DAYS_DEFAULT = 7;
export const IMAGE_CACHE_IDLE_DAYS_MIN = 1;
export const IMAGE_CACHE_IDLE_DAYS_MAX = 90;

export const IMAGE_PROXY_SOURCES = [
  'tmdb',
  'tvdb',
  'anilist',
  'simkl',
] as const;
export type ImageProxySource = (typeof IMAGE_PROXY_SOURCES)[number];

export const IMAGE_CACHE_STAT_SOURCES = [
  'tmdb',
  'tvdb',
  'avatar',
  'anilist',
  'simkl',
] as const;
export type ImageCacheStatSource = (typeof IMAGE_CACHE_STAT_SOURCES)[number];

type HostMapping = {
  source: ImageProxySource;
  origin: string;
};

const HOSTS: Record<string, HostMapping> = {
  'image.tmdb.org': { source: 'tmdb', origin: 'https://image.tmdb.org' },
  'artworks.thetvdb.com': {
    source: 'tvdb',
    origin: 'https://artworks.thetvdb.com',
  },
  's4.anilist.co': { source: 'anilist', origin: 'https://s4.anilist.co' },
  'img.anilist.co': { source: 'anilist', origin: 'https://img.anilist.co' },
  'simkl.in': { source: 'simkl', origin: 'https://simkl.in' },
  'www.simkl.in': { source: 'simkl', origin: 'https://www.simkl.in' },
};

const SOURCE_ORIGINS: Record<ImageProxySource, string> = {
  tmdb: 'https://image.tmdb.org',
  tvdb: 'https://artworks.thetvdb.com',
  anilist: '',
  simkl: '',
};

const MULTI_HOST_SOURCES = new Set<ImageProxySource>(['anilist', 'simkl']);

const HOST_SEGMENT =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

export const isImageProxySource = (value: string): value is ImageProxySource =>
  (IMAGE_PROXY_SOURCES as readonly string[]).includes(value);

export const clampImageCacheIdleDays = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return IMAGE_CACHE_IDLE_DAYS_DEFAULT;
  }
  return Math.min(
    IMAGE_CACHE_IDLE_DAYS_MAX,
    Math.max(IMAGE_CACHE_IDLE_DAYS_MIN, Math.round(parsed))
  );
};

const parseHttpsUrl = (value: string): URL | null => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password || url.port) return null;
    return url;
  } catch {
    return null;
  }
};

const unwrapWsrv = (url: URL): URL | null => {
  if (url.hostname !== 'wsrv.nl' && url.hostname !== 'www.wsrv.nl') {
    return url;
  }
  const inner = url.searchParams.get('url');
  if (!inner) return null;
  const nested = parseHttpsUrl(inner);
  if (!nested) return null;
  if (nested.hostname !== 'simkl.in' && nested.hostname !== 'www.simkl.in') {
    return null;
  }
  return nested;
};

export const toImageProxyPath = (src: string): string | null => {
  const parsed = parseHttpsUrl(src);
  if (!parsed) return null;
  const url = unwrapWsrv(parsed);
  if (!url) return null;
  const mapping = HOSTS[url.hostname];
  if (!mapping) return null;
  const search = url.search && url.search !== '?' ? url.search : '';
  if (MULTI_HOST_SOURCES.has(mapping.source)) {
    return `/imageproxy/${mapping.source}/${url.hostname}${url.pathname}${search}`;
  }
  return `/imageproxy/${mapping.source}${url.pathname}${search}`;
};

export const rewriteCachedImageSrc = (
  src: string,
  cacheImages: boolean
): string => {
  if (!cacheImages || src.startsWith('/')) return src;
  return toImageProxyPath(src) ?? src;
};

export const resolveImageProxyFetch = (
  source: string,
  path: string,
  search = ''
):
  | { source: ImageProxySource; fetchUrl: string }
  | { error: 'unsupported' | 'invalid' } => {
  if (!isImageProxySource(source)) return { error: 'unsupported' };
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')) {
    return { error: 'invalid' };
  }

  const query = search.startsWith('?') ? search : search ? `?${search}` : '';

  if (MULTI_HOST_SOURCES.has(source)) {
    const segments = path.split('/').filter(Boolean);
    const host = segments[0];
    if (!host || !HOST_SEGMENT.test(host)) return { error: 'invalid' };
    const mapping = HOSTS[host];
    if (!mapping || mapping.source !== source) return { error: 'invalid' };
    const rest = segments.slice(1).join('/');
    if (!rest) return { error: 'invalid' };
    return { source, fetchUrl: `${mapping.origin}/${rest}${query}` };
  }

  return { source, fetchUrl: `${SOURCE_ORIGINS[source]}${path}${query}` };
};
