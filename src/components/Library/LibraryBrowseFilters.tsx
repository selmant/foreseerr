import Button from '@app/components/Common/Button';
import SegmentedControl from '@app/components/Common/SegmentedControl';
import SlideOver from '@app/components/Common/SlideOver';
import defineMessages from '@app/utils/defineMessages';
import { XCircleIcon } from '@heroicons/react/24/outline';
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
  watchStatus: 'Watch Status',
  any: 'Any',
  unwatched: 'Unwatched',
  inProgress: 'In Progress',
  played: 'Played',
  genres: 'Genres',
  noGenres: 'No genres available.',
  releaseYear: 'Release Year',
  yearFrom: 'From',
  yearTo: 'To',
  reset: 'Clear Active Filters',
});

type WatchFilter = NonNullable<ParsedLibraryBrowseQuery['watched']> | 'any';

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

const parseYear = (value: string) => {
  const year = Number(value);
  return value.trim() && Number.isInteger(year) ? year : undefined;
};

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
      <div className="flex flex-col space-y-4">
        <div>
          <div className="mb-2 text-lg font-semibold">
            {intl.formatMessage(messages.watchStatus)}
          </div>
          <SegmentedControl<WatchFilter>
            ariaLabel={intl.formatMessage(messages.watchStatus)}
            size="sm"
            columns={2}
            value={state.watched ?? 'any'}
            onChange={(value) =>
              onChange({
                watched: value === 'any' ? undefined : value,
                skip: 0,
              })
            }
            options={[
              { value: 'any', label: intl.formatMessage(messages.any) },
              {
                value: 'unwatched',
                label: intl.formatMessage(messages.unwatched),
              },
              {
                value: 'inProgress',
                label: intl.formatMessage(messages.inProgress),
              },
              { value: 'played', label: intl.formatMessage(messages.played) },
            ]}
          />
        </div>

        <div>
          <div className="mb-2 text-lg font-semibold">
            {intl.formatMessage(messages.genres)}
          </div>
          {genres.length ? (
            <div className="flex flex-wrap gap-2">
              {genres.map((genre) => {
                const active = Boolean(state.genre?.includes(genre));
                return (
                  <button
                    key={genre}
                    type="button"
                    aria-pressed={active}
                    className={`rounded-full px-3 py-1 text-sm font-medium transition-colors ${
                      active
                        ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                        : 'bg-gray-700 text-gray-200 hover:bg-gray-600'
                    }`}
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
        </div>

        <div>
          <div className="mb-2 text-lg font-semibold">
            {intl.formatMessage(messages.releaseYear)}
          </div>
          <div className="flex space-x-2">
            <div className="flex flex-1 flex-col">
              <label
                htmlFor="libraryYearFrom"
                className="mb-2 text-base font-normal text-white"
              >
                {intl.formatMessage(messages.yearFrom)}
              </label>
              <input
                id="libraryYearFrom"
                type="text"
                inputMode="numeric"
                placeholder={yearMin ? String(yearMin) : undefined}
                value={state.yearFrom ?? ''}
                onChange={(event) =>
                  onChange({
                    yearFrom: parseYear(event.target.value),
                    skip: 0,
                  })
                }
              />
            </div>
            <div className="flex flex-1 flex-col">
              <label
                htmlFor="libraryYearTo"
                className="mb-2 text-base font-normal text-white"
              >
                {intl.formatMessage(messages.yearTo)}
              </label>
              <input
                id="libraryYearTo"
                type="text"
                inputMode="numeric"
                placeholder={yearMax ? String(yearMax) : undefined}
                value={state.yearTo ?? ''}
                onChange={(event) =>
                  onChange({
                    yearTo: parseYear(event.target.value),
                    skip: 0,
                  })
                }
              />
            </div>
          </div>
        </div>

        <div className="pt-4">
          <Button
            className="w-full"
            disabled={activeFilterCount === 0}
            onClick={() => {
              onReset();
              onClose();
            }}
          >
            <XCircleIcon />
            <span>{intl.formatMessage(messages.reset)}</span>
          </Button>
        </div>
      </div>
    </SlideOver>
  );
};

export default LibraryBrowseFilters;
