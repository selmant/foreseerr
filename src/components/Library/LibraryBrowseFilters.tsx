import Button from '@app/components/Common/Button';
import SlideOver from '@app/components/Common/SlideOver';
import defineMessages from '@app/utils/defineMessages';
import {
  countActiveLibraryBrowseFilters,
  toggleLibraryBrowseGenre,
  type ParsedLibraryBrowseQuery,
} from '@server/lib/libraryBrowseQuery';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Library.LibraryBrowseFilters', {
  title: 'Filters',
  activefilters:
    '{count, plural, one {# Active Filter} other {# Active Filters}}',
  watchStatus: 'Watch status',
  any: 'Any',
  unwatched: 'Unwatched',
  inProgress: 'In progress',
  played: 'Played',
  genres: 'Genres',
  noGenres: 'No genres available.',
  yearFrom: 'From year',
  yearTo: 'To year',
  reset: 'Clear Active Filters',
});

interface LibraryBrowseFiltersProps {
  show: boolean;
  state: ParsedLibraryBrowseQuery;
  genres: string[];
  yearMin?: number;
  yearMax?: number;
  onChange: (patch: Partial<ParsedLibraryBrowseQuery>) => void;
  onReset: () => void;
  onClose: () => void;
}

const chipClass = (active: boolean) =>
  `min-h-11 rounded-md px-3 text-sm ${
    active
      ? 'bg-indigo-600 text-white'
      : 'bg-gray-800 text-gray-300 ring-1 ring-gray-700'
  }`;

const LibraryBrowseFilters = ({
  show,
  state,
  genres,
  yearMin,
  yearMax,
  onChange,
  onReset,
  onClose,
}: LibraryBrowseFiltersProps) => {
  const intl = useIntl();
  const activeFilterCount = countActiveLibraryBrowseFilters(state);

  return (
    <SlideOver
      show={show}
      title={intl.formatMessage(messages.title)}
      subText={intl.formatMessage(messages.activefilters, {
        count: activeFilterCount,
      })}
      onClose={onClose}
    >
      <div className="space-y-6">
        <fieldset>
          <legend className="mb-2 text-sm font-semibold text-gray-300">
            {intl.formatMessage(messages.watchStatus)}
          </legend>
          <div className="flex flex-wrap gap-2">
            {(
              [
                [undefined, messages.any],
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
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-sm font-semibold text-gray-300">
            {intl.formatMessage(messages.genres)}
          </legend>
          {genres.length ? (
            <div className="flex max-h-64 flex-wrap gap-2 overflow-y-auto">
              {genres.map((genre) => {
                const active = Boolean(state.genre?.includes(genre));
                return (
                  <button
                    key={genre}
                    type="button"
                    aria-pressed={active}
                    className={chipClass(active)}
                    onClick={() =>
                      onChange({
                        genre: toggleLibraryBrowseGenre(state.genre, genre),
                        skip: 0,
                      })
                    }
                  >
                    {genre}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-gray-400">
              {intl.formatMessage(messages.noGenres)}
            </p>
          )}
        </fieldset>

        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm text-gray-300">
            {intl.formatMessage(messages.yearFrom)}
            <input
              type="number"
              className="mt-1 min-h-11 w-full rounded-md border border-gray-700 bg-gray-900 px-3 text-gray-100"
              placeholder={yearMin ? String(yearMin) : undefined}
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
          </label>
          <label className="text-sm text-gray-300">
            {intl.formatMessage(messages.yearTo)}
            <input
              type="number"
              className="mt-1 min-h-11 w-full rounded-md border border-gray-700 bg-gray-900 px-3 text-gray-100"
              placeholder={yearMax ? String(yearMax) : undefined}
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
          </label>
        </div>

        {activeFilterCount > 0 ? (
          <Button buttonType="ghost" className="w-full" onClick={onReset}>
            {intl.formatMessage(messages.reset)}
          </Button>
        ) : null}
      </div>
    </SlideOver>
  );
};

export default LibraryBrowseFilters;
