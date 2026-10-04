export const requestFilters = [
  'all',
  'pending',
  'approved',
  'completed',
  'processing',
  'failed',
  'available',
  'unavailable',
  'deleted',
] as const;
export type RequestFilter = (typeof requestFilters)[number];
export const requestPageSizes = [5, 10, 25, 50, 100];

export interface RequestListState {
  filter: RequestFilter;
  mediaType: 'all' | 'movie' | 'tv';
  sort: 'added' | 'modified';
  sortDirection: 'asc' | 'desc';
  pageSize: number;
  page: number;
}

const choice = <T extends string>(
  value: unknown,
  options: readonly T[],
  fallback: T
): T => (options.includes(value as T) ? (value as T) : fallback);

export const parseRequestListState = (
  search: string,
  preferences: unknown = {}
): RequestListState => {
  const params = new URLSearchParams(search);
  const stored =
    preferences && typeof preferences === 'object'
      ? (preferences as Record<string, unknown>)
      : {};
  const read = (key: string, preference: string) =>
    params.has(key) ? params.get(key) : stored[preference];
  const page = Number(params.get('page'));
  const pageSize = Number(read('pageSize', 'currentPageSize'));
  return {
    filter: choice(read('filter', 'currentFilter'), requestFilters, 'pending'),
    mediaType: choice(
      read('mediaType', 'currentMediaType'),
      ['all', 'movie', 'tv'],
      'all'
    ),
    sort: choice(read('sort', 'currentSort'), ['added', 'modified'], 'added'),
    sortDirection: choice(
      read('sortDirection', 'currentSortDirection'),
      ['asc', 'desc'],
      'desc'
    ),
    pageSize: requestPageSizes.includes(pageSize) ? pageSize : 10,
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
};

export const requestListPath = (
  pathname: string,
  state: RequestListState,
  search: string
): string => {
  const params = new URLSearchParams(search);
  // Explicit filter values make Back and shared links independent of saved preferences.
  params.set('filter', state.filter);
  params.set('mediaType', state.mediaType);
  params.set('sort', state.sort);
  params.set('sortDirection', state.sortDirection);
  params.set('pageSize', String(state.pageSize));
  if (state.page > 1) params.set('page', String(state.page));
  else params.delete('page');
  return `${pathname}?${params}`;
};
