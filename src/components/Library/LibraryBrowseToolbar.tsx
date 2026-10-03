import Button from '@app/components/Common/Button';
import SegmentedControl from '@app/components/Common/SegmentedControl';
import defineMessages from '@app/utils/defineMessages';
import {
  BarsArrowDownIcon,
  FunnelIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/solid';
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
  sortDateAdded: 'Recently Added',
  sortTitleAsc: 'Title A–Z',
  sortTitleDesc: 'Title Z–A',
  sortPremiereNewest: 'Newest Release',
  sortPremiereOldest: 'Oldest Release',
  sortLastPlayed: 'Last Played',
  comfortable: 'Comfortable',
  compact: 'Compact',
  activefilters:
    '{count, plural, one {# Active Filter} other {# Active Filters}}',
  results: '{count, number} titles',
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
    <div className="sm:sticky-below-searchbar -mx-4 space-y-3 bg-gray-900/95 px-4 py-3 backdrop-blur sm:sticky sm:z-40">
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="flex flex-grow">
          <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100 sm:text-sm">
            <MagnifyingGlassIcon className="h-5 w-5" />
          </span>
          <input
            type="text"
            inputMode="search"
            data-testid="library-browse-search"
            aria-label={intl.formatMessage(messages.searchPlaceholder)}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={intl.formatMessage(messages.searchPlaceholder)}
            className="rounded-r-only"
          />
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="flex flex-grow lg:flex-grow-0">
            <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100 sm:text-sm">
              <BarsArrowDownIcon className="h-6 w-6" />
            </span>
            <select
              aria-label={intl.formatMessage(messages.sortBy)}
              className="rounded-r-only"
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
          <Button onClick={onOpenFilters} className="w-full sm:w-auto">
            <FunnelIcon />
            <span>
              {intl.formatMessage(messages.activefilters, {
                count: activeFilterCount,
              })}
            </span>
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <SegmentedControl<MediaTypeOption>
          ariaLabel={intl.formatMessage(messages.mediaType)}
          size="sm"
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
        <div className="flex items-center justify-between gap-3 sm:ml-auto sm:justify-end">
          {resultCount != null ? (
            <span className="text-sm text-gray-400">
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
    </div>
  );
};

export default LibraryBrowseToolbar;
