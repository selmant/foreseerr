import type {
  LibraryBrowseOrder,
  LibraryBrowseSort,
  LibraryWatchedFilter,
} from '@server/interfaces/api/libraryInterfaces';

export type LibraryDensity = 'comfortable' | 'compact';

export const LIBRARY_DENSITY_KEY = 'foreseer.library.density';

export const parseLibraryDensity = (value: unknown): LibraryDensity =>
  value === 'compact' ? 'compact' : 'comfortable';

export interface ParsedLibraryBrowseQuery {
  q?: string;
  mediaType?: 'movie' | 'tv';
  watched?: LibraryWatchedFilter;
  genre?: string[];
  yearFrom?: number;
  yearTo?: number;
  sort: LibraryBrowseSort;
  order: LibraryBrowseOrder;
  take: number;
  skip: number;
}

const SORTS: LibraryBrowseSort[] = [
  'dateAdded',
  'title',
  'premiereDate',
  'lastPlayed',
];
const ORDERS: LibraryBrowseOrder[] = ['asc', 'desc'];
const WATCHED: LibraryWatchedFilter[] = ['unwatched', 'inProgress', 'played'];

const first = (value: unknown): string | undefined => {
  if (Array.isArray(value)) {
    return first(value[0]);
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  return undefined;
};

const asEnum = <T extends string>(
  value: unknown,
  allowed: T[]
): T | undefined => {
  const raw = first(value);
  return raw && (allowed as string[]).includes(raw) ? (raw as T) : undefined;
};

const asInt = (value: unknown): number | undefined => {
  const raw = first(value);
  if (raw == null || raw === '') {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const asGenres = (value: unknown): string[] | undefined => {
  if (value == null || value === '') {
    return undefined;
  }
  const list = Array.isArray(value) ? value : [value];
  const genres = list
    .flatMap((entry) => String(entry).split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);
  return genres.length ? genres : undefined;
};

export const parseLibraryBrowseQuery = (
  input: Record<string, unknown>
): ParsedLibraryBrowseQuery => {
  const q = first(input.q)?.trim() || undefined;
  const takeRaw = asInt(input.take);
  const skipRaw = asInt(input.skip);
  const yearFrom = asInt(input.yearFrom);
  const yearTo = asInt(input.yearTo);
  const mediaType = asEnum(input.mediaType, ['movie', 'tv']);
  const parsed: ParsedLibraryBrowseQuery = {
    sort: asEnum(input.sort, SORTS) ?? 'dateAdded',
    order: asEnum(input.order, ORDERS) ?? 'desc',
    take: Math.min(50, Math.max(1, takeRaw ?? 24)),
    skip: Math.max(0, skipRaw ?? 0),
  };
  if (q) {
    parsed.q = q;
  }
  if (mediaType) {
    parsed.mediaType = mediaType;
  }
  const watched = asEnum(input.watched, WATCHED);
  if (watched) {
    parsed.watched = watched;
  }
  const genre = asGenres(input.genre);
  if (genre) {
    parsed.genre = genre;
  }
  if (yearFrom != null) {
    parsed.yearFrom = yearFrom;
  }
  if (yearTo != null) {
    parsed.yearTo = yearTo;
  }
  return parsed;
};

export const serializeLibraryBrowseQuery = (
  query: ParsedLibraryBrowseQuery
): URLSearchParams => {
  const params = new URLSearchParams();
  if (query.q) {
    params.set('q', query.q);
  }
  if (query.mediaType) {
    params.set('mediaType', query.mediaType);
  }
  if (query.watched) {
    params.set('watched', query.watched);
  }
  for (const genre of query.genre ?? []) {
    params.append('genre', genre);
  }
  if (query.yearFrom != null) {
    params.set('yearFrom', String(query.yearFrom));
  }
  if (query.yearTo != null) {
    params.set('yearTo', String(query.yearTo));
  }
  if (query.sort !== 'dateAdded') {
    params.set('sort', query.sort);
  }
  if (query.order !== 'desc') {
    params.set('order', query.order);
  }
  if (query.take !== 24) {
    params.set('take', String(query.take));
  }
  if (query.skip !== 0) {
    params.set('skip', String(query.skip));
  }
  return params;
};
