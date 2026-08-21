import { hasDiscoverTmdbId } from '@server/lib/discover/unmapped';

export class MdblistNotConfiguredError extends Error {
  constructor(message = 'MDBList API key is not configured') {
    super(message);
    this.name = 'MdblistNotConfiguredError';
  }
}

export class MdblistUnavailableError extends Error {
  constructor(message = 'MDBList is temporarily unavailable') {
    super(message);
    this.name = 'MdblistUnavailableError';
  }
}

export class MdblistListNotFoundError extends Error {
  constructor(message = 'MDBList list not found') {
    super(message);
    this.name = 'MdblistListNotFoundError';
  }
}

export type MdblistListRef =
  | { kind: 'id'; listId: number }
  | { kind: 'slug'; username: string; slug: string };

export interface MdblistListMetadata {
  id: number;
  name: string;
  slug: string;
  user_name?: string;
  user_id?: number;
  mediatype?: string;
  items?: number;
  likes?: number;
  description?: string;
}

export interface MdblistPublicList {
  id: number;
  name: string;
  slug: string;
  username: string;
  mediaType: string;
  itemCount: number;
  likes: number;
}

export interface MdblistDiscoverItem {
  tmdbId?: number;
  mediaType: 'movie' | 'tv';
  title: string;
  rank?: number;
  imdbId?: string;
}

export interface MdblistListItemPayload {
  id?: number;
  rank?: number;
  title?: string;
  mediatype?: string;
  type?: string;
  ids?: {
    tmdb?: number | null;
    imdb?: string | null;
  };
}

export interface MdblistListItemsPayload {
  movies?: MdblistListItemPayload[];
  shows?: MdblistListItemPayload[];
  items?: MdblistListItemPayload[];
  unified?: MdblistListItemPayload[];
}

const MDBLIST_HOSTS = new Set(['mdblist.com', 'www.mdblist.com']);

export const parseMdblistListRef = (value: string): MdblistListRef => {
  const text = decodeURIComponent(String(value || '').trim());
  if (!text) {
    throw new Error('List URL or reference is required');
  }

  if (/^\d+$/.test(text)) {
    return { kind: 'id', listId: Number(text) };
  }

  const asUrl = text.startsWith('http://') || text.startsWith('https://');
  if (asUrl || text.includes('mdblist.com/')) {
    let parsed: URL;
    try {
      parsed = new URL(asUrl ? text : `https://${text}`);
    } catch {
      throw new Error(`Invalid MDBList list URL: ${value}`);
    }

    const host = parsed.hostname.toLowerCase();
    if (!MDBLIST_HOSTS.has(host)) {
      throw new Error(`Unsupported MDBList list URL: ${value}`);
    }

    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts[0] === 'lists' && parts.length >= 3) {
      const username = parts[1];
      const slug = parts[2] === 'json' ? '' : parts[2];
      if (username && slug) {
        return { kind: 'slug', username, slug };
      }
    }

    if (parts[0] === 'lists' && parts.length === 2 && /^\d+$/.test(parts[1])) {
      return { kind: 'id', listId: Number(parts[1]) };
    }

    throw new Error(`Unsupported MDBList list URL: ${value}`);
  }

  if (text.includes('/')) {
    const [username, ...rest] = text.split('/');
    const slug = rest
      .join('/')
      .replace(/\/json\/?$/, '')
      .trim();
    if (!username?.trim() || !slug) {
      throw new Error(`Invalid MDBList list reference: ${value}`);
    }
    return { kind: 'slug', username: username.trim(), slug };
  }

  throw new Error(`Invalid MDBList list reference: ${value}`);
};

export const formatMdblistListReference = (
  list: Pick<MdblistListMetadata, 'id' | 'slug' | 'user_name'>
): string => {
  if (list.user_name && list.slug) {
    return `${list.user_name}/${list.slug}`;
  }
  return String(list.id);
};

export const collectMdblistListItems = (
  payload: MdblistListItemsPayload | MdblistListItemPayload[] | null | undefined
): MdblistListItemPayload[] => {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  return [
    ...(payload.movies ?? []),
    ...(payload.shows ?? []),
    ...(payload.items ?? []),
    ...(payload.unified ?? []),
  ];
};

const toMediaType = (value: string | undefined): 'movie' | 'tv' | undefined => {
  if (value === 'movie') {
    return 'movie';
  }
  if (value === 'show' || value === 'tv') {
    return 'tv';
  }
  return undefined;
};

export const mapMdblistListItem = (
  item: MdblistListItemPayload
): MdblistDiscoverItem | null => {
  const tmdbRaw = Number(item.ids?.tmdb ?? item.id);
  const tmdbId = Number.isFinite(tmdbRaw) && tmdbRaw > 0 ? tmdbRaw : undefined;
  const imdbId = item.ids?.imdb?.trim() || undefined;
  const title = item.title?.trim() || (tmdbId ? String(tmdbId) : imdbId) || '';
  if (!title) {
    return null;
  }

  const mediaType = toMediaType(item.mediatype ?? item.type) ?? 'movie';

  return {
    ...(hasDiscoverTmdbId(tmdbId) ? { tmdbId } : {}),
    mediaType,
    title,
    rank: Number.isFinite(item.rank) ? Number(item.rank) : undefined,
    ...(imdbId ? { imdbId } : {}),
  };
};

export const mapMdblistListItems = (
  payload: MdblistListItemsPayload | MdblistListItemPayload[] | null | undefined
): MdblistDiscoverItem[] => {
  const mapped = collectMdblistListItems(payload)
    .map(mapMdblistListItem)
    .filter((item): item is MdblistDiscoverItem => item !== null);

  return mapped.sort((a, b) => {
    const rankA = a.rank ?? Number.MAX_SAFE_INTEGER;
    const rankB = b.rank ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    return a.title.localeCompare(b.title);
  });
};

export const normalizeMdblistListMetadata = (
  payload: unknown
): MdblistListMetadata[] => {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? [payload]
      : [];

  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object') {
      return [];
    }
    const list = row as MdblistListMetadata;
    const id = Number(list.id);
    if (!Number.isFinite(id) || id <= 0) {
      return [];
    }
    return [
      {
        id,
        name: String(list.name ?? '').trim() || String(id),
        slug: String(list.slug ?? '').trim(),
        user_name: list.user_name,
        user_id: list.user_id,
        mediatype: list.mediatype,
        items: list.items,
        likes: list.likes,
        description: list.description,
      },
    ];
  });
};

export const mapMdblistPublicLists = (
  payload: unknown
): MdblistPublicList[] => {
  const grouped = new Map<string, MdblistPublicList>();

  for (const list of normalizeMdblistListMetadata(payload)) {
    const username = list.user_name ?? '';
    const reference = formatMdblistListReference(list);
    const existing = grouped.get(reference);
    const itemCount = Number(list.items) || 0;
    const likes = Number(list.likes) || 0;

    if (existing) {
      existing.itemCount += itemCount;
      existing.likes = Math.max(existing.likes, likes);
      continue;
    }

    grouped.set(reference, {
      id: list.id,
      name: list.name,
      slug: list.slug || String(list.id),
      username,
      mediaType: list.mediatype ?? '',
      itemCount,
      likes,
    });
  }

  return [...grouped.values()];
};
