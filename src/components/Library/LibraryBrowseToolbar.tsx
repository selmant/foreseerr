import defineMessages from '@app/utils/defineMessages';
import type {
  LibraryDensity,
  ParsedLibraryBrowseQuery,
} from '@server/lib/libraryBrowseQuery';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Library.LibraryBrowseToolbar', {
  searchPlaceholder: 'Search your library…',
  all: 'All',
  movies: 'Movies',
  series: 'Series',
  unwatched: 'Unwatched',
  inProgress: 'In progress',
  played: 'Played',
  sortDateAdded: 'Recently added',
  sortTitleAsc: 'Title A–Z',
  sortTitleDesc: 'Title Z–A',
  sortPremiereNewest: 'Release newest',
  sortPremiereOldest: 'Release oldest',
  sortLastPlayed: 'Last played',
  comfortable: 'Comfortable',
  compact: 'Compact',
  filters: 'Filters',
  results: '{count, number} titles',
  yearFrom: 'From year',
  yearTo: 'To year',
  reset: 'Reset filters',
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
  genres: string[];
  yearMin?: number;
  yearMax?: number;
  resultCount?: number;
  onChange: (patch: Partial<ParsedLibraryBrowseQuery>) => void;
  onDensityChange: (density: LibraryDensity) => void;
  onReset: () => void;
  onOpenFilters?: () => void;
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
  genres,
  yearMin,
  yearMax,
  resultCount,
  onChange,
  onDensityChange,
  onReset,
  onOpenFilters,
}: LibraryBrowseToolbarProps) => {
  const intl = useIntl();
  const sortValue = `${state.sort}:${state.order}`;

  return (
    <div className="sticky top-0 z-20 space-y-3 bg-gray-900/95 py-3 backdrop-blur">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={intl.formatMessage(messages.searchPlaceholder)}
          className="min-h-11 w-full flex-1 rounded-md border border-gray-700 bg-library-charcoal px-3 text-sm text-gray-100 placeholder:text-gray-500 focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
        />
        {onOpenFilters ? (
          <button
            type="button"
            className="min-h-11 rounded-md bg-indigo-600 px-4 text-sm text-white lg:hidden"
            onClick={onOpenFilters}
          >
            {intl.formatMessage(messages.filters)}
          </button>
        ) : null}
      </div>
      <div className="hidden flex-wrap items-center gap-2 lg:flex">
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
        {(
          [
            [undefined, messages.all],
            ['unwatched', messages.unwatched],
            ['inProgress', messages.inProgress],
            ['played', messages.played],
          ] as const
        ).map(([value, msg]) => (
          <button
            key={`watched-${String(value)}`}
            type="button"
            aria-pressed={state.watched === value}
            className={chipClass(state.watched === value)}
            onClick={() => onChange({ watched: value, skip: 0 })}
          >
            {intl.formatMessage(msg)}
          </button>
        ))}
        <select
          aria-label="Sort"
          className="min-h-11 rounded-md border border-gray-700 bg-library-charcoal px-2 text-sm text-gray-100"
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
        <select
          multiple
          aria-label="Genres"
          className="min-h-11 min-w-[10rem] rounded-md border border-gray-700 bg-library-charcoal px-2 text-sm text-gray-100"
          value={state.genre ?? []}
          onChange={(event) => {
            const selected = Array.from(event.target.selectedOptions).map(
              (option) => option.value
            );
            onChange({
              genre: selected.length ? selected : undefined,
              skip: 0,
            });
          }}
        >
          {genres.map((genre) => (
            <option key={genre} value={genre}>
              {genre}
            </option>
          ))}
        </select>
        <input
          type="number"
          aria-label={intl.formatMessage(messages.yearFrom)}
          className="min-h-11 w-24 rounded-md border border-gray-700 bg-library-charcoal px-2 text-sm text-gray-100"
          placeholder={yearMin ? String(yearMin) : 'From'}
          value={state.yearFrom ?? ''}
          onChange={(event) =>
            onChange({
              yearFrom: event.target.value
                ? Number(event.target.value)
                : undefined,
              skip: 0,
            })
          }
        />
        <input
          type="number"
          aria-label={intl.formatMessage(messages.yearTo)}
          className="min-h-11 w-24 rounded-md border border-gray-700 bg-library-charcoal px-2 text-sm text-gray-100"
          placeholder={yearMax ? String(yearMax) : 'To'}
          value={state.yearTo ?? ''}
          onChange={(event) =>
            onChange({
              yearTo: event.target.value
                ? Number(event.target.value)
                : undefined,
              skip: 0,
            })
          }
        />
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
        <button
          type="button"
          className="min-h-11 text-sm text-gray-400 underline"
          onClick={onReset}
        >
          {intl.formatMessage(messages.reset)}
        </button>
        {resultCount != null ? (
          <span className="text-sm text-gray-400">
            {intl.formatMessage(messages.results, { count: resultCount })}
          </span>
        ) : null}
      </div>
    </div>
  );
};

export default LibraryBrowseToolbar;
