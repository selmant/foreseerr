import {
  LIBRARY_DENSITY_KEY,
  parseLibraryBrowseQuery,
  parseLibraryDensity,
  serializeLibraryBrowseQuery,
  type LibraryDensity,
  type ParsedLibraryBrowseQuery,
} from '@server/lib/libraryBrowseQuery';
import type { ParsedUrlQuery } from 'querystring';

export type LibraryBrowsePageState = ParsedLibraryBrowseQuery & {
  density: LibraryDensity;
};

const fromQueryRecord = (query: ParsedUrlQuery): Record<string, unknown> => {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    record[key] = value;
  }
  return record;
};

export const readStoredDensity = (): LibraryDensity => {
  if (typeof window === 'undefined') {
    return 'comfortable';
  }
  try {
    return parseLibraryDensity(
      window.localStorage.getItem(LIBRARY_DENSITY_KEY)
    );
  } catch {
    return 'comfortable';
  }
};

export const storeDensity = (density: LibraryDensity) => {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(LIBRARY_DENSITY_KEY, density);
  } catch {
    // ignore quota / private mode
  }
};

export const browseStateFromQuery = (
  query: ParsedUrlQuery
): LibraryBrowsePageState => {
  const parsed = parseLibraryBrowseQuery(fromQueryRecord(query));
  const density =
    query.density != null
      ? parseLibraryDensity(query.density)
      : readStoredDensity();
  return { ...parsed, density };
};

export const serializeBrowseState = (
  state: LibraryBrowsePageState
): URLSearchParams => {
  const params = serializeLibraryBrowseQuery(state);
  if (state.density === 'compact') {
    params.set('density', 'compact');
  }
  return params;
};

export const LIBRARY_SCROLL_KEY = 'foreseer.library.browse.scroll';

export const storeBrowseScroll = (scrollY: number) => {
  try {
    window.sessionStorage.setItem(LIBRARY_SCROLL_KEY, String(scrollY));
  } catch {
    // ignore
  }
};

export const restoreBrowseScroll = (): number | undefined => {
  try {
    const raw = window.sessionStorage.getItem(LIBRARY_SCROLL_KEY);
    if (!raw) {
      return undefined;
    }
    window.sessionStorage.removeItem(LIBRARY_SCROLL_KEY);
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
};
