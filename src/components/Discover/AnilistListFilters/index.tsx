import Button from '@app/components/Common/Button';
import MultiRangeSlider from '@app/components/Common/MultiRangeSlider';
import SlideOver from '@app/components/Common/SlideOver';
import type { AnilistSort } from '@app/components/Discover/AnilistListFilters/anilistFilterOptions';
import {
  anilistAiringStatuses,
  anilistCountries,
  anilistFormats,
  anilistGenres,
  anilistPanelKeys,
  anilistScoreFilters,
  anilistSorts,
  anilistYearRange,
  countAnilistFilters,
  defaultAnilistOrder,
} from '@app/components/Discover/AnilistListFilters/anilistFilterOptions';
import {
  ChipGroup,
  DebouncedSearchInput,
  FilterSectionTitle as SectionTitle,
  SortDirectionButton,
  splitList,
} from '@app/components/Discover/ListFilterControls';
import {
  areDiscoverDefaultsCleared,
  markDiscoverDefaultsCleared,
} from '@app/components/Discover/mergeFilterDefaults';
import { useDiscoverFilterDefaults } from '@app/hooks/useDiscoverFilterDefaults';
import useRouteQuery from '@app/hooks/useRouteQuery';
import {
  useBatchUpdateQueryParams,
  useUpdateQueryParams,
} from '@app/hooks/useUpdateQueryParams';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { XCircleIcon } from '@heroicons/react/24/outline';
import { FunnelIcon } from '@heroicons/react/24/solid';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import Select from 'react-select';

const messages = defineMessages('components.Discover.AnilistListFilters', {
  search: 'Search',
  searchPlaceholder: 'Search this list',
  sortLabel: 'Sort',
  sortDefault: 'List Order',
  filters: 'AniList Filters',
  activefilters:
    '{count, plural, one {# Active Filter} other {# Active Filters}}',
  format: 'Format',
  airingStatus: 'Airing Status',
  genres: 'Genres',
  genresPlaceholder: 'Any genre',
  genresTip: 'Titles must have every genre picked.',
  country: 'Country',
  year: 'Release Year',
  yearText: 'Released {minValue}–{maxValue}',
  scores: 'Scores',
  scoresTip:
    'On AniList’s 0–100 scale. Leave a slider at its full range to skip it.',
  averageScore: 'Average Score',
  myScore: 'List Owner’s Score',
  myScoreTip: 'Entries the list’s owner has not scored are left out.',
  scoreText: '{label} between {minValue} and {maxValue}',
  visibility: 'Visibility',
  hideUnmapped: 'Hide Unmapped Titles',
  hideUnmappedTip: 'Hide titles that could not be mapped to TMDB.',
  clearfilters: 'Clear Active Filters',
  sortScore: 'Score',
  sortTitle: 'Title',
  sortProgress: 'Progress',
  sortUpdatedAt: 'Last Updated',
  sortCreatedAt: 'Last Added',
  sortReleaseDate: 'Release Date',
  sortAverageScore: 'Average Score',
  sortPopularity: 'Popularity',
  formatTv: 'TV',
  formatTvShort: 'TV Short',
  formatMovie: 'Movie',
  formatSpecial: 'Special',
  formatOva: 'OVA',
  formatOna: 'ONA',
  formatMusic: 'Music',
  statusReleasing: 'Airing',
  statusFinished: 'Finished',
  statusNotYetReleased: 'Not Yet Aired',
  statusCancelled: 'Cancelled',
  statusHiatus: 'Hiatus',
  countryJp: 'Japan',
  countryKr: 'South Korea',
  countryCn: 'China',
  countryTw: 'Taiwan',
});

const sortMessages: Record<AnilistSort, keyof typeof messages> = {
  score: 'sortScore',
  title: 'sortTitle',
  progress: 'sortProgress',
  updatedAt: 'sortUpdatedAt',
  createdAt: 'sortCreatedAt',
  releaseDate: 'sortReleaseDate',
  averageScore: 'sortAverageScore',
  popularity: 'sortPopularity',
};

const formatMessages: Record<
  (typeof anilistFormats)[number],
  keyof typeof messages
> = {
  TV: 'formatTv',
  TV_SHORT: 'formatTvShort',
  MOVIE: 'formatMovie',
  SPECIAL: 'formatSpecial',
  OVA: 'formatOva',
  ONA: 'formatOna',
  MUSIC: 'formatMusic',
};

const statusMessages: Record<
  (typeof anilistAiringStatuses)[number],
  keyof typeof messages
> = {
  RELEASING: 'statusReleasing',
  FINISHED: 'statusFinished',
  NOT_YET_RELEASED: 'statusNotYetReleased',
  CANCELLED: 'statusCancelled',
  HIATUS: 'statusHiatus',
};

const countryMessages: Record<
  (typeof anilistCountries)[number],
  keyof typeof messages
> = {
  JP: 'countryJp',
  KR: 'countryKr',
  CN: 'countryCn',
  TW: 'countryTw',
};

const pickKnown = <T extends string>(value: unknown, known: readonly T[]) =>
  splitList(value).filter((v): v is T =>
    (known as readonly string[]).includes(v)
  );

/**
 * Filters for an AniList list view, mirroring anilist.co's list sidebar:
 * search and sort up front; format, airing status, genres, country, and
 * release years in the panel. The whole list is filtered before paging.
 */
const AnilistListFilters = () => {
  const intl = useIntl();
  const query = useRouteQuery();
  const { user } = useUser();
  const updateQueryParams = useUpdateQueryParams({});
  const batchUpdateQueryParams = useBatchUpdateQueryParams({});
  const [showFilters, setShowFilters] = useState(false);
  // Remounts the year slider after "Clear".
  const [resetKey, setResetKey] = useState(0);
  const { data: discoverDefaults } = useDiscoverFilterDefaults();

  const sort = anilistSorts.find((s) => s === query.sort);
  const order =
    query.order === 'asc' || query.order === 'desc'
      ? query.order
      : sort
        ? defaultAnilistOrder(sort)
        : undefined;
  const formats = pickKnown(query.format, anilistFormats);
  const statuses = pickKnown(query.airingStatus, anilistAiringStatuses);
  const countries = pickKnown(query.country, anilistCountries);
  const genres = pickKnown(query.genres, anilistGenres);
  const { min: yearMin, max: yearMax } = anilistYearRange();
  const yearFrom = Number(query.yearFrom) || undefined;
  const yearTo = Number(query.yearTo) || undefined;
  const hideUnmapped =
    query.hideUnmapped === 'true' ||
    (query.hideUnmapped !== 'false' &&
      !areDiscoverDefaultsCleared(user?.id) &&
      discoverDefaults?.hideUnmapped === true);
  const activeCount = countAnilistFilters(query);
  const listParam = (values: string[]) =>
    values.length ? values.join(',') : undefined;

  const clearFilters = () => {
    markDiscoverDefaultsCleared(user?.id);
    batchUpdateQueryParams({
      ...Object.fromEntries(anilistPanelKeys.map((k) => [k, undefined])),
      hideUnmapped: 'false',
    });
    setResetKey((k) => k + 1);
    setShowFilters(false);
  };

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="w-full min-w-0 sm:w-64">
        <label
          htmlFor="anilistSearch"
          className="mb-1 block text-sm text-gray-300"
        >
          {intl.formatMessage(messages.search)}
        </label>
        <DebouncedSearchInput
          id="anilistSearch"
          value={typeof query.search === 'string' ? query.search : ''}
          placeholder={intl.formatMessage(messages.searchPlaceholder)}
          onChange={(value) => updateQueryParams('search', value)}
        />
      </div>
      <div className="flex w-full min-w-0 items-end gap-2 sm:w-72">
        <div className="min-w-0 flex-1">
          <label
            htmlFor="anilistSort"
            className="mb-1 block text-sm text-gray-300"
          >
            {intl.formatMessage(messages.sortLabel)}
          </label>
          <select
            id="anilistSort"
            className="min-h-[44px] w-full"
            value={sort ?? ''}
            onChange={(e) => {
              const next = anilistSorts.find((s) => s === e.target.value);
              batchUpdateQueryParams({
                sort: next,
                order: next ? defaultAnilistOrder(next) : undefined,
              });
            }}
          >
            <option value="">{intl.formatMessage(messages.sortDefault)}</option>
            {anilistSorts.map((s) => (
              <option key={s} value={s}>
                {intl.formatMessage(messages[sortMessages[s]])}
              </option>
            ))}
          </select>
        </div>
        <SortDirectionButton
          order={order}
          disabled={!sort}
          onChange={(next) => updateQueryParams('order', next)}
        />
      </div>
      <div className="w-full sm:w-auto">
        <Button
          onClick={() => setShowFilters(true)}
          className="min-h-[44px] w-full"
          aria-haspopup="dialog"
          aria-expanded={showFilters}
        >
          <FunnelIcon />
          <span>
            {intl.formatMessage(messages.activefilters, {
              count: activeCount,
            })}
          </span>
        </Button>
      </div>
      <SlideOver
        show={showFilters}
        title={intl.formatMessage(messages.filters)}
        subText={intl.formatMessage(messages.activefilters, {
          count: activeCount,
        })}
        onClose={() => setShowFilters(false)}
      >
        <div className="flex flex-col space-y-6" key={resetKey}>
          <div>
            <SectionTitle>{intl.formatMessage(messages.format)}</SectionTitle>
            <ChipGroup
              label={intl.formatMessage(messages.format)}
              options={anilistFormats.map((value) => ({
                value,
                label: intl.formatMessage(messages[formatMessages[value]]),
              }))}
              selected={formats}
              onChange={(picked) =>
                updateQueryParams('format', listParam(picked))
              }
            />
          </div>
          <div>
            <SectionTitle>
              {intl.formatMessage(messages.airingStatus)}
            </SectionTitle>
            <ChipGroup
              label={intl.formatMessage(messages.airingStatus)}
              options={anilistAiringStatuses.map((value) => ({
                value,
                label: intl.formatMessage(messages[statusMessages[value]]),
              }))}
              selected={statuses}
              onChange={(picked) =>
                updateQueryParams('airingStatus', listParam(picked))
              }
            />
          </div>
          <div>
            <SectionTitle>{intl.formatMessage(messages.genres)}</SectionTitle>
            <Select<{ value: string; label: string }, true>
              aria-label={intl.formatMessage(messages.genres)}
              className="react-select-container"
              classNamePrefix="react-select"
              isMulti
              options={anilistGenres.map((g) => ({ value: g, label: g }))}
              value={genres.map((g) => ({ value: g, label: g }))}
              placeholder={intl.formatMessage(messages.genresPlaceholder)}
              onChange={(value) =>
                updateQueryParams(
                  'genres',
                  listParam(value.map((v) => v.value))
                )
              }
            />
            <p className="mt-1 text-sm text-gray-400">
              {intl.formatMessage(messages.genresTip)}
            </p>
          </div>
          <div>
            <SectionTitle>{intl.formatMessage(messages.country)}</SectionTitle>
            <ChipGroup
              label={intl.formatMessage(messages.country)}
              options={anilistCountries.map((value) => ({
                value,
                label: intl.formatMessage(messages[countryMessages[value]]),
              }))}
              selected={countries}
              onChange={(picked) =>
                updateQueryParams('country', listParam(picked))
              }
            />
          </div>
          <div>
            <SectionTitle>{intl.formatMessage(messages.year)}</SectionTitle>
            <div className="relative z-0">
              <MultiRangeSlider
                label={intl.formatMessage(messages.year)}
                min={yearMin}
                max={yearMax}
                defaultMinValue={yearFrom}
                defaultMaxValue={yearTo}
                onUpdateMin={(value) =>
                  updateQueryParams(
                    'yearFrom',
                    value > yearMin ? String(value) : undefined
                  )
                }
                onUpdateMax={(value) =>
                  updateQueryParams(
                    'yearTo',
                    value < yearMax ? String(value) : undefined
                  )
                }
                subText={intl.formatMessage(messages.yearText, {
                  minValue: yearFrom ?? yearMin,
                  maxValue: yearTo ?? yearMax,
                })}
              />
            </div>
          </div>
          <div>
            <SectionTitle>{intl.formatMessage(messages.scores)}</SectionTitle>
            <div className="flex flex-col space-y-4">
              <p className="text-sm text-gray-400">
                {intl.formatMessage(messages.scoresTip)}
              </p>
              {anilistScoreFilters.map((score) => {
                const minKey = `${score}Min`;
                const maxKey = `${score}Max`;
                const min = Number(query[minKey]) || undefined;
                const max =
                  typeof query[maxKey] === 'string' && query[maxKey] !== ''
                    ? Number(query[maxKey])
                    : undefined;
                const label = intl.formatMessage(messages[score]);
                return (
                  <div key={score}>
                    <div className="mb-1 font-semibold">{label}</div>
                    <div className="relative z-0">
                      <MultiRangeSlider
                        label={label}
                        min={0}
                        max={100}
                        defaultMinValue={min}
                        defaultMaxValue={max}
                        onUpdateMin={(value) =>
                          updateQueryParams(
                            minKey,
                            value > 0 ? String(value) : undefined
                          )
                        }
                        onUpdateMax={(value) =>
                          updateQueryParams(
                            maxKey,
                            value < 100 ? String(value) : undefined
                          )
                        }
                        subText={intl.formatMessage(messages.scoreText, {
                          label,
                          minValue: min ?? 0,
                          maxValue: max ?? 100,
                        })}
                      />
                    </div>
                    {score === 'myScore' && (
                      <p className="mt-1 text-sm text-gray-400">
                        {intl.formatMessage(messages.myScoreTip)}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div>
            <SectionTitle>
              {intl.formatMessage(messages.visibility)}
            </SectionTitle>
            <label
              htmlFor="anilistHideUnmapped"
              className="flex cursor-pointer items-center gap-3"
            >
              <input
                type="checkbox"
                id="anilistHideUnmapped"
                checked={hideUnmapped}
                onChange={(e) =>
                  updateQueryParams(
                    'hideUnmapped',
                    e.target.checked ? 'true' : 'false'
                  )
                }
              />
              <span>{intl.formatMessage(messages.hideUnmapped)}</span>
            </label>
            <p className="ml-9 mt-1 text-sm text-gray-400">
              {intl.formatMessage(messages.hideUnmappedTip)}
            </p>
          </div>
          <div className="pt-2">
            <Button
              className="w-full"
              disabled={activeCount === 0}
              onClick={clearFilters}
            >
              <XCircleIcon />
              <span>{intl.formatMessage(messages.clearfilters)}</span>
            </Button>
          </div>
        </div>
      </SlideOver>
    </div>
  );
};

export default AnilistListFilters;
