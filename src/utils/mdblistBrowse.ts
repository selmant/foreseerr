import type {
  WatchlistItem,
  WatchlistResponse,
} from '@shared/interfaces/api/discoverInterfaces';

import type { FilterOptions } from '@app/components/Discover/constants';

export const mdblistSortOptions = [
  'source',
  'release_date.desc',
  'first_air_date.desc',
  'popularity.desc',
  'vote_average.desc',
] as const;
export const mdblistSort = (value?: string) =>
  mdblistSortOptions.find((sort) => sort === value) ?? 'source';

export type MdblistView = Pick<
  FilterOptions,
  | 'sortBy'
  | 'primaryReleaseDateGte'
  | 'primaryReleaseDateLte'
  | 'firstAirDateGte'
  | 'firstAirDateLte'
>;
export type MdblistPage = WatchlistResponse & { title?: string };

const validDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;

export const validDateRange = (view: MdblistView) =>
  [
    view.primaryReleaseDateGte,
    view.primaryReleaseDateLte,
    view.firstAirDateGte,
    view.firstAirDateLte,
  ].every((value) => !value || validDate(value)) &&
  (!view.primaryReleaseDateGte ||
    !view.primaryReleaseDateLte ||
    view.primaryReleaseDateGte <= view.primaryReleaseDateLte) &&
  (!view.firstAirDateGte ||
    !view.firstAirDateLte ||
    view.firstAirDateGte <= view.firstAirDateLte);

const titleDate = (item: WatchlistItem): string => {
  const date = item.mediaType === 'tv' ? item.firstAirDate : item.releaseDate;
  return date && validDate(date) ? date : '';
};

export const viewMdblistItems = (
  items: WatchlistItem[],
  view: MdblistView = {}
): WatchlistItem[] => {
  if (!validDateRange(view)) return [];
  const { sortBy = 'source' } = view;
  const filtered = items.filter((item) => {
    const from =
      item.mediaType === 'tv'
        ? (view.firstAirDateGte ?? view.primaryReleaseDateGte)
        : view.primaryReleaseDateGte;
    const to =
      item.mediaType === 'tv'
        ? (view.firstAirDateLte ?? view.primaryReleaseDateLte)
        : view.primaryReleaseDateLte;
    if (!from && !to) return true;
    const date = titleDate(item);
    return Boolean(date) && (!from || date >= from) && (!to || date <= to);
  });
  if (sortBy === 'source') return filtered;
  return filtered.sort((a, b) => {
    if (sortBy === 'popularity.desc' || sortBy === 'vote_average.desc') {
      const key = sortBy === 'popularity.desc' ? 'popularity' : 'voteAverage';
      const score = (item: WatchlistItem) =>
        typeof item[key] === 'number' && Number.isFinite(item[key])
          ? item[key]
          : -1;
      const difference = score(b) - score(a);
      if (difference) return difference;
    }
    return titleDate(b).localeCompare(titleDate(a));
  });
};

/** Sort only a complete list: later pages may contain the newest titles. */
export const loadMdblistPages = async (
  fetchPage: (page: number) => Promise<MdblistPage>
): Promise<MdblistPage> => {
  const results: WatchlistItem[] = [];
  const seen = new Set<string>();
  let title: string | undefined;
  for (let page = 1; page <= 100; page++) {
    const data = await fetchPage(page);
    title ??= data.title;
    for (const item of data.results) {
      const identity = `${item.mediaType ?? 'unknown'}:${item.ratingKey}`;
      if (!seen.has(identity)) {
        seen.add(identity);
        results.push(item);
      }
    }
    const hasMore =
      typeof data.hasMore === 'boolean'
        ? data.hasMore
        : data.totalPages != null && page < data.totalPages;
    if (!hasMore) {
      return {
        page: 1,
        hasMore: false,
        totalResults: results.length,
        results,
        title,
      };
    }
  }
  throw new Error(
    'List exceeds 100 pages; refusing to sort an incomplete list.'
  );
};
