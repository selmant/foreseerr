import Button from '@app/components/Common/Button';
import SegmentedControl from '@app/components/Common/SegmentedControl';
import defineMessages from '@app/utils/defineMessages';
import {
  BarsArrowDownIcon,
  FunnelIcon,
  MagnifyingGlassIcon,
  XMarkIcon,
} from '@heroicons/react/24/solid';
import {
  countActiveLibraryBrowseFilters,
  type LibraryDensity,
  type ParsedLibraryBrowseQuery,
} from '@server/lib/libraryBrowseQuery';
import { useEffect, useId, useRef } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Library.LibraryBrowseToolbar', {
  searchPlaceholder: 'Search your library…',
  all: 'All',
  movies: 'Movies',
  series: 'Series',
  sortDateAdded: 'Recently Added',
  sortTitleAsc: 'Title A–Z',
  sortTitleDesc: 'Title Z–A',
  sortPremiereNewest: 'Newest Release',
  sortPremiereOldest: 'Oldest Release',
  sortLastPlayed: 'Last Played',
  comfortable: 'Comfortable',
  compact: 'Compact',
  filters: 'Filters',
  activefilters:
    '{count, plural, one {Filters, # active filter} other {Filters, # active filters}}',
  results: '{count, plural, one {# title} other {# titles}}',
  clearSearch: 'Clear search',
  clearFilters: 'Clear filters',
  removeFilter: 'Remove filter: {filter}',
  watchStatus: 'Watch status',
  anyStatus: 'Any status',
  unwatched: 'Unwatched',
  inProgress: 'In progress',
  watched: 'Watched',
  yearFrom: 'From {year, number, ::group-off}',
  yearTo: 'Through {year, number, ::group-off}',
  sortBy: 'Sort',
  mediaType: 'Media type',
  density: 'Grid density',
});

export const SORT_OPTIONS = [
  { sort: 'dateAdded', order: 'desc', key: 'sortDateAdded' },
  { sort: 'title', order: 'asc', key: 'sortTitleAsc' },
  { sort: 'title', order: 'desc', key: 'sortTitleDesc' },
  { sort: 'premiereDate', order: 'desc', key: 'sortPremiereNewest' },
  { sort: 'premiereDate', order: 'asc', key: 'sortPremiereOldest' },
  { sort: 'lastPlayed', order: 'desc', key: 'sortLastPlayed' },
] as const;

type MediaTypeOption = 'all' | 'movie' | 'tv';
type WatchStatusOption =
  | NonNullable<ParsedLibraryBrowseQuery['watched']>
  | 'any';

interface LibraryBrowseToolbarProps {
  focusSearch?: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  state: ParsedLibraryBrowseQuery;
  density: LibraryDensity;
  resultCount?: number;
  onChange: (patch: Partial<ParsedLibraryBrowseQuery>) => void;
  onDensityChange: (density: LibraryDensity) => void;
  onOpenFilters: () => void;
  onResetFilters: () => void;
}

const LibraryBrowseToolbar = ({
  focusSearch = false,
  query,
  onQueryChange,
  state,
  density,
  resultCount,
  onChange,
  onDensityChange,
  onOpenFilters,
  onResetFilters,
}: LibraryBrowseToolbarProps) => {
  const intl = useIntl();
  const searchRef = useRef<HTMLInputElement>(null);
  const filterButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusSearch) searchRef.current?.focus();
  }, [focusSearch]);
  const watchStatusId = useId();
  const sortValue = `${state.sort}:${state.order}`;
  const activeFilterCount = countActiveLibraryBrowseFilters(state);
  const watchedLabels = {
    unwatched: intl.formatMessage(messages.unwatched),
    inProgress: intl.formatMessage(messages.inProgress),
    played: intl.formatMessage(messages.watched),
  };
  const filterChips: {
    id: string;
    label: string;
    patch: Partial<ParsedLibraryBrowseQuery>;
  }[] = [
    ...(state.watched
      ? [
          {
            id: 'watched',
            label: watchedLabels[state.watched],
            patch: { watched: undefined },
          },
        ]
      : []),
    ...(state.genre ?? []).map((genre) => ({
      id: `genre:${genre}`,
      label: genre,
      patch: { genre: state.genre?.filter((value) => value !== genre) },
    })),
    ...(state.yearFrom != null
      ? [
          {
            id: 'yearFrom',
            label: intl.formatMessage(messages.yearFrom, {
              year: state.yearFrom,
            }),
            patch: { yearFrom: undefined },
          },
        ]
      : []),
    ...(state.yearTo != null
      ? [
          {
            id: 'yearTo',
            label: intl.formatMessage(messages.yearTo, { year: state.yearTo }),
            patch: { yearTo: undefined },
          },
        ]
      : []),
  ];

  return (
    <div className="sm:sticky-below-searchbar -mx-4 space-y-3 bg-gray-900/95 px-4 py-3 backdrop-blur sm:sticky sm:z-40">
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex min-w-0 flex-grow">
          <MagnifyingGlassIcon
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400"
          />
          <input
            ref={searchRef}
            id="library-search"
            type="text"
            inputMode="search"
            data-testid="library-browse-search"
            aria-label={intl.formatMessage(messages.searchPlaceholder)}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={intl.formatMessage(messages.searchPlaceholder)}
            className="min-h-11 pl-10 pr-12"
          />
          {query ? (
            <button
              type="button"
              aria-label={intl.formatMessage(messages.clearSearch)}
              onClick={() => {
                onQueryChange('');
                searchRef.current?.focus();
              }}
              className="absolute right-0 top-0 flex h-full min-w-11 items-center justify-center rounded-r-md text-gray-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              <XMarkIcon aria-hidden="true" className="h-5 w-5" />
            </button>
          ) : null}
        </div>
        <div className="flex min-w-0 gap-2">
          <div className="flex min-w-0 flex-grow lg:flex-grow-0">
            <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100 sm:text-sm">
              <BarsArrowDownIcon className="h-6 w-6" />
            </span>
            <select
              aria-label={intl.formatMessage(messages.sortBy)}
              className="rounded-r-only min-h-11 min-w-0"
              value={sortValue}
              onChange={(event) => {
                const [sort, order] = event.target.value.split(':') as [
                  ParsedLibraryBrowseQuery['sort'],
                  ParsedLibraryBrowseQuery['order'],
                ];
                onChange({ sort, order, skip: 0 });
              }}
            >
              {SORT_OPTIONS.map((option) => (
                <option
                  key={`${option.sort}:${option.order}`}
                  value={`${option.sort}:${option.order}`}
                >
                  {intl.formatMessage(messages[option.key])}
                </option>
              ))}
            </select>
          </div>
          <Button
            ref={filterButton}
            onClick={onOpenFilters}
            className="min-h-11 shrink-0"
            aria-label={intl.formatMessage(messages.activefilters, {
              count: activeFilterCount,
            })}
          >
            <FunnelIcon />
            <span>{intl.formatMessage(messages.filters)}</span>
            {activeFilterCount > 0 ? (
              <span
                aria-hidden="true"
                className="ml-2 rounded-full bg-indigo-500/20 px-2 text-indigo-200"
              >
                {activeFilterCount}
              </span>
            ) : null}
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <SegmentedControl<MediaTypeOption>
          ariaLabel={intl.formatMessage(messages.mediaType)}
          className="w-full sm:inline-grid sm:w-auto sm:min-w-[15rem]"
          value={state.mediaType ?? 'all'}
          onChange={(value) =>
            onChange({
              mediaType: value === 'all' ? undefined : value,
              skip: 0,
            })
          }
          options={[
            { value: 'all', label: intl.formatMessage(messages.all) },
            { value: 'movie', label: intl.formatMessage(messages.movies) },
            { value: 'tv', label: intl.formatMessage(messages.series) },
          ]}
        />
        <div className="flex items-center gap-3 sm:hidden">
          <label
            htmlFor={watchStatusId}
            className="shrink-0 text-sm text-gray-400"
          >
            {intl.formatMessage(messages.watchStatus)}
          </label>
          <select
            id={watchStatusId}
            className="min-h-11"
            value={state.watched ?? 'any'}
            onChange={(event) =>
              onChange({
                watched:
                  event.target.value === 'any'
                    ? undefined
                    : (event.target
                        .value as ParsedLibraryBrowseQuery['watched']),
              })
            }
          >
            <option value="any">
              {intl.formatMessage(messages.anyStatus)}
            </option>
            {(['unwatched', 'inProgress', 'played'] as const).map((value) => (
              <option key={value} value={value}>
                {watchedLabels[value]}
              </option>
            ))}
          </select>
        </div>
        <SegmentedControl<WatchStatusOption>
          ariaLabel={intl.formatMessage(messages.watchStatus)}
          className="hidden sm:inline-grid sm:w-auto"
          value={state.watched ?? 'any'}
          onChange={(value) =>
            onChange({ watched: value === 'any' ? undefined : value })
          }
          options={[
            { value: 'any', label: intl.formatMessage(messages.anyStatus) },
            ...(['unwatched', 'inProgress', 'played'] as const).map(
              (value) => ({ value, label: watchedLabels[value] })
            ),
          ]}
        />
        <div className="flex items-center justify-between gap-3 sm:ml-auto sm:justify-end">
          {resultCount != null ? (
            <span role="status" className="text-sm text-gray-400">
              {intl.formatMessage(messages.results, { count: resultCount })}
            </span>
          ) : null}
          <SegmentedControl<LibraryDensity>
            ariaLabel={intl.formatMessage(messages.density)}
            size="sm"
            className="inline-grid"
            value={density}
            onChange={onDensityChange}
            options={[
              {
                value: 'comfortable',
                label: intl.formatMessage(messages.comfortable),
              },
              { value: 'compact', label: intl.formatMessage(messages.compact) },
            ]}
          />
        </div>
      </div>
      {filterChips.length ? (
        <div className="flex flex-wrap items-center gap-2">
          {filterChips.map(({ id, label, patch }) => (
            <button
              key={id}
              type="button"
              aria-label={intl.formatMessage(messages.removeFilter, {
                filter: label,
              })}
              onClick={() => {
                onChange(patch);
                filterButton.current?.focus();
              }}
              className="flex min-h-11 items-center gap-2 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 text-sm text-indigo-200 hover:bg-indigo-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              {label}
              <XMarkIcon aria-hidden="true" className="h-4 w-4 shrink-0" />
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              onResetFilters();
              filterButton.current?.focus();
            }}
            className="min-h-11 rounded-md px-3 text-sm text-gray-300 underline underline-offset-4 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            {intl.formatMessage(messages.clearFilters)}
          </button>
        </div>
      ) : null}
    </div>
  );
};

export default LibraryBrowseToolbar;
