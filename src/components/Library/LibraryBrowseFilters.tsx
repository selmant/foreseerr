import Alert from '@app/components/Common/Alert';
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
import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Library.LibraryBrowseFilters', {
  title: 'Filters',
  activefilters:
    '{count, plural, one {# Active Filter} other {# Active Filters}}',
  watchStatus: 'Watch Status',
  any: 'Any',
  unwatched: 'Unwatched',
  inProgress: 'In Progress',
  played: 'Watched',
  genres: 'Genres',
  noGenres: 'No genres available.',
  releaseYear: 'Release Year',
  yearFrom: 'From',
  yearTo: 'To',
  reset: 'Clear filters',
  hint: 'Watch status and genres update immediately. Apply a year range to narrow your results further.',
  applyYears: 'Apply year range',
  invalidYear: 'Enter a four-digit year.',
  invalidRange: 'From must be earlier than or equal to To.',
  loadingGenres: 'Loading genres…',
  genresError: 'Could not refresh library genres.',
  retryGenres: 'Retry genres',
  showResults: '{count, plural, one {Show # title} other {Show # titles}}',
  done: 'Show results',
});

type WatchFilter = NonNullable<ParsedLibraryBrowseQuery['watched']> | 'any';

interface LibraryBrowseFiltersProps {
  show: boolean;
  state: ParsedLibraryBrowseQuery;
  genres: string[];
  yearMin?: number;
  yearMax?: number;
  resultCount?: number;
  loadingResults?: boolean;
  genresLoading?: boolean;
  genresError?: boolean;
  onRetryGenres?: () => void;
  onChange: (patch: Partial<ParsedLibraryBrowseQuery>) => void;
  onReset: () => void;
  onClose: () => void;
}

const parseYear = (value: string) => {
  const year = Number(value);
  return /^\d{4}$/.test(value.trim()) && year >= 1000 ? year : undefined;
};

const LibraryBrowseFilters = ({
  show,
  state,
  genres,
  yearMin,
  yearMax,
  resultCount,
  loadingResults = false,
  genresLoading = false,
  genresError = false,
  onRetryGenres,
  onChange,
  onReset,
  onClose,
}: LibraryBrowseFiltersProps) => {
  const intl = useIntl();
  const activeFilterCount = countActiveLibraryBrowseFilters(state);
  const [yearFrom, setYearFrom] = useState(String(state.yearFrom ?? ''));
  const [yearTo, setYearTo] = useState(String(state.yearTo ?? ''));
  const [validateYears, setValidateYears] = useState(false);
  const fromInput = useRef<HTMLInputElement>(null);
  const toInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setYearFrom(String(state.yearFrom ?? ''));
    setValidateYears(false);
  }, [show, state.yearFrom]);
  useEffect(() => {
    setYearTo(String(state.yearTo ?? ''));
    setValidateYears(false);
  }, [show, state.yearTo]);
  const from = parseYear(yearFrom);
  const to = parseYear(yearTo);
  const invalidFrom = Boolean(yearFrom.trim() && from === undefined);
  const invalidTo = Boolean(yearTo.trim() && to === undefined);
  const invalidRange = from !== undefined && to !== undefined && from > to;
  const yearsChanged =
    yearFrom !== String(state.yearFrom ?? '') ||
    yearTo !== String(state.yearTo ?? '');
  const applyYears = () => {
    if (invalidFrom || invalidTo || invalidRange) {
      setValidateYears(true);
      (invalidFrom ? fromInput.current : toInput.current)?.focus();
      return false;
    }
    if (yearsChanged) onChange({ yearFrom: from, yearTo: to, skip: 0 });
    setValidateYears(false);
    return true;
  };

  return (
    <SlideOver
      show={show}
      title={intl.formatMessage(messages.title)}
      subText={intl.formatMessage(messages.activefilters, {
        count: activeFilterCount,
      })}
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <Button
            className="min-h-11 flex-1 justify-center"
            aria-disabled={activeFilterCount === 0 && !yearsChanged}
            onClick={() => {
              if (activeFilterCount === 0 && !yearsChanged) return;
              setYearFrom('');
              setYearTo('');
              setValidateYears(false);
              onReset();
            }}
          >
            <XCircleIcon />
            <span>{intl.formatMessage(messages.reset)}</span>
          </Button>
          <Button
            buttonType="primary"
            className="min-h-11 flex-1 justify-center"
            onClick={() => {
              if (applyYears()) onClose();
            }}
          >
            {resultCount != null && !loadingResults && !yearsChanged
              ? intl.formatMessage(messages.showResults, { count: resultCount })
              : intl.formatMessage(messages.done)}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col space-y-4">
        <p className="text-sm text-gray-400">
          {intl.formatMessage(messages.hint)}
        </p>
        <div>
          <h3 className="mb-2 text-lg font-semibold">
            {intl.formatMessage(messages.watchStatus)}
          </h3>
          <SegmentedControl<WatchFilter>
            ariaLabel={intl.formatMessage(messages.watchStatus)}
            columns={2}
            wrapLabels
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
          <h3 className="mb-2 text-lg font-semibold">
            {intl.formatMessage(messages.genres)}
          </h3>
          {genresError ? (
            <div className="mb-3" role="status">
              <Alert
                type="warning"
                title={intl.formatMessage(messages.genresError)}
              >
                {onRetryGenres ? (
                  <Button
                    type="button"
                    className="mt-2 min-h-11"
                    aria-disabled={genresLoading}
                    aria-busy={genresLoading}
                    onClick={() => {
                      if (!genresLoading) onRetryGenres();
                    }}
                  >
                    {intl.formatMessage(messages.retryGenres)}
                  </Button>
                ) : null}
              </Alert>
            </div>
          ) : null}
          {genres.length ? (
            <div className="flex flex-wrap gap-2">
              {genres.map((genre) => {
                const active = Boolean(state.genre?.includes(genre));
                return (
                  <button
                    key={genre}
                    type="button"
                    aria-pressed={active}
                    className={`min-h-11 rounded-full px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
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
          ) : genresLoading ? (
            <p role="status" className="text-sm text-gray-400">
              {intl.formatMessage(messages.loadingGenres)}
            </p>
          ) : !genresError ? (
            <p className="text-sm text-gray-400">
              {intl.formatMessage(messages.noGenres)}
            </p>
          ) : null}
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            applyYears();
          }}
        >
          <h3 className="mb-2 text-lg font-semibold">
            {intl.formatMessage(messages.releaseYear)}
          </h3>
          <div className="flex space-x-2">
            <div className="flex min-w-0 flex-1 flex-col">
              <label
                htmlFor="libraryYearFrom"
                className="mb-2 text-base font-normal text-white"
              >
                {intl.formatMessage(messages.yearFrom)}
              </label>
              <input
                id="libraryYearFrom"
                ref={fromInput}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                className="min-h-11 min-w-0"
                maxLength={4}
                aria-invalid={validateYears && (invalidFrom || invalidRange)}
                aria-describedby={
                  validateYears && (invalidFrom || invalidRange)
                    ? 'library-year-error'
                    : undefined
                }
                placeholder={yearMin ? String(yearMin) : undefined}
                value={yearFrom}
                onChange={(event) => setYearFrom(event.target.value)}
              />
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <label
                htmlFor="libraryYearTo"
                className="mb-2 text-base font-normal text-white"
              >
                {intl.formatMessage(messages.yearTo)}
              </label>
              <input
                id="libraryYearTo"
                ref={toInput}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                className="min-h-11 min-w-0"
                maxLength={4}
                aria-invalid={validateYears && (invalidTo || invalidRange)}
                aria-describedby={
                  validateYears && (invalidTo || invalidRange)
                    ? 'library-year-error'
                    : undefined
                }
                placeholder={yearMax ? String(yearMax) : undefined}
                value={yearTo}
                onChange={(event) => setYearTo(event.target.value)}
              />
            </div>
          </div>
          {validateYears && (invalidFrom || invalidTo || invalidRange) ? (
            <p
              id="library-year-error"
              role="alert"
              className="mt-2 text-sm text-yellow-200"
            >
              {intl.formatMessage(
                invalidFrom || invalidTo
                  ? messages.invalidYear
                  : messages.invalidRange
              )}
            </p>
          ) : null}
          <Button
            type="submit"
            className="mt-3 min-h-11"
            aria-disabled={!yearsChanged}
          >
            {intl.formatMessage(messages.applyYears)}
          </Button>
        </form>
      </div>
    </SlideOver>
  );
};

export default LibraryBrowseFilters;
