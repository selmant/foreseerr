import defineMessages from '@app/utils/defineMessages';
import { BarsArrowDownIcon, FunnelIcon } from '@heroicons/react/24/solid';
import {
  countActiveLibraryBrowseFilters,
  type LibraryDensity,
  type ParsedLibraryBrowseQuery,
} from '@server/lib/libraryBrowseQuery';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Library.LibraryBrowseToolbar', {
  searchPlaceholder: 'Search your library…',
  all: 'All',
  movies: 'Movies',
  series: 'Series',
  sortDateAdded: 'Recently added',
  sortTitleAsc: 'Title A–Z',
  sortTitleDesc: 'Title Z–A',
  sortPremiereNewest: 'Release newest',
  sortPremiereOldest: 'Release oldest',
  sortLastPlayed: 'Last played',
  comfortable: 'Comfortable',
  compact: 'Compact',
  activefilters:
    '{count, plural, one {# Active Filter} other {# Active Filters}}',
  results: '{count, number} titles',
  sortBy: 'Sort',
});

export const SORT_OPTIONS = [
  { sort: 'dateAdded', order: 'desc', key: 'sortDateAdded' },
  { sort: 'title', order: 'asc', key: 'sortTitleAsc' },
  { sort: 'title', order: 'desc', key: 'sortTitleDesc' },
  { sort: 'premiereDate', order: 'desc', key: 'sortPremiereNewest' },
  { sort: 'premiereDate', order: 'asc', key: 'sortPremiereOldest' },
  { sort: 'lastPlayed', order: 'desc', key: 'sortLastPlayed' },
] as const;

interface LibraryBrowseToolbarProps {
  query: string;
  onQueryChange: (value: string) => void;
  state: ParsedLibraryBrowseQuery;
  density: LibraryDensity;
  resultCount?: number;
  onChange: (patch: Partial<ParsedLibraryBrowseQuery>) => void;
  onDensityChange: (density: LibraryDensity) => void;
  onOpenFilters: () => void;
}

const chipClass = (active: boolean) =>
  `min-h-11 rounded-md px-3 text-sm ${
    active
      ? 'bg-indigo-600 text-white'
      : 'bg-library-charcoal text-gray-300 ring-1 ring-gray-700'
  }`;

const LibraryBrowseToolbar = ({
  query,
  onQueryChange,
  state,
  density,
  resultCount,
  onChange,
  onDensityChange,
  onOpenFilters,
}: LibraryBrowseToolbarProps) => {
  const intl = useIntl();
  const sortValue = `${state.sort}:${state.order}`;
  const activeFilterCount = countActiveLibraryBrowseFilters(state);

  return (
    <div className="sticky top-0 z-20 space-y-3 bg-gray-900/95 py-3 backdrop-blur">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="search"
          data-testid="library-browse-search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={intl.formatMessage(messages.searchPlaceholder)}
          className="min-h-11 w-full flex-1 rounded-md border border-gray-700 bg-library-charcoal px-3 text-sm text-gray-100 placeholder:text-gray-500 focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
        />
        <div className="flex shrink-0 gap-2">
          <div className="flex min-w-0 flex-1 sm:flex-none">
            <span className="inline-flex items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100">
              <BarsArrowDownIcon className="h-5 w-5" />
            </span>
            <select
              aria-label={intl.formatMessage(messages.sortBy)}
              className="min-h-11 min-w-0 flex-1 rounded-r-md border border-gray-500 bg-gray-800 px-2 text-sm text-gray-100 sm:w-48"
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
          <button
            type="button"
            className="inline-flex min-h-11 items-center gap-2 rounded-md bg-indigo-600 px-4 text-sm text-white"
            onClick={onOpenFilters}
          >
            <FunnelIcon className="h-5 w-5" />
            <span>
              {intl.formatMessage(messages.activefilters, {
                count: activeFilterCount,
              })}
            </span>
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            [undefined, messages.all],
            ['movie', messages.movies],
            ['tv', messages.series],
          ] as const
        ).map(([value, msg]) => (
          <button
            key={String(value)}
            type="button"
            aria-pressed={state.mediaType === value}
            className={chipClass(state.mediaType === value)}
            onClick={() => onChange({ mediaType: value, skip: 0 })}
          >
            {intl.formatMessage(msg)}
          </button>
        ))}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-pressed={density === 'comfortable'}
            className={chipClass(density === 'comfortable')}
            onClick={() => onDensityChange('comfortable')}
          >
            {intl.formatMessage(messages.comfortable)}
          </button>
          <button
            type="button"
            aria-pressed={density === 'compact'}
            className={chipClass(density === 'compact')}
            onClick={() => onDensityChange('compact')}
          >
            {intl.formatMessage(messages.compact)}
          </button>
          {resultCount != null ? (
            <span className="text-sm text-gray-400">
              {intl.formatMessage(messages.results, { count: resultCount })}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default LibraryBrowseToolbar;
