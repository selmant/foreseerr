import Button from '@app/components/Common/Button';
import MultiRangeSlider from '@app/components/Common/MultiRangeSlider';
import SlideOver from '@app/components/Common/SlideOver';
import type { AnilistSort } from '@app/components/Discover/AnilistListFilters/anilistFilterOptions';
import {
  anilistAiringStatuses,
  anilistClearParams,
  anilistCountries,
  anilistFormats,
  anilistGenres,
  anilistScoreFilters,
  anilistSortOption,
  anilistSortOptions,
  anilistSorts,
  anilistYearRange,
  countAnilistFilters,
  defaultAnilistOrder,
} from '@app/components/Discover/AnilistListFilters/anilistFilterOptions';
import {
  ChipGroup,
  DebouncedSearchInput,
  FilterButton,
  FilterSectionTitle as SectionTitle,
  SortDirectionButton,
  SortMenu,
  listFilterMessages,
  splitList,
} from '@app/components/Discover/ListFilterControls';
import { groupSorts } from '@app/components/Discover/listSort';
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
import { useState } from 'react';
import { useIntl } from 'react-intl';
import Select from 'react-select';

const messages = defineMessages('components.Discover.AnilistListFilters', {
  format: 'Format',
  airingStatus: 'Airing Status',
  genresPlaceholder: 'Select genres',
  genresTip: 'Titles must have every genre picked.',
  country: 'Country',
  scores: 'Scores',
  scoresTip:
    'On AniList’s 0–100 scale. Leave a slider at its full range to skip it.',
  averageScore: 'Average Score',
  myScore: 'List Owner’s Score',
  myScoreTip: 'Entries the list’s owner has not scored are left out.',
  sortScore: 'List Owner’s Score',
  sortTitle: 'Title',
  sortProgress: 'List Owner’s Progress',
  sortUpdatedAt: 'Last Updated',
  sortCreatedAt: 'Date Added',
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

  const sortLabel = (value: AnilistSort) =>
    intl.formatMessage(messages[sortMessages[value]]);

  const clearFilters = () => {
    markDiscoverDefaultsCleared(user?.id);
    batchUpdateQueryParams(anilistClearParams());
    setResetKey((k) => k + 1);
    setShowFilters(false);
  };

  return (
    <>
      <div className="flex gap-2 sm:contents">
        <div className="min-w-0 flex-1 sm:order-1 sm:w-56 sm:flex-none">
          <DebouncedSearchInput
            id="anilistSearch"
            withIcon
            value={typeof query.search === 'string' ? query.search : ''}
            label={intl.formatMessage(listFilterMessages.search)}
            placeholder={intl.formatMessage(
              listFilterMessages.searchPlaceholder
            )}
            onChange={(value) => updateQueryParams('search', value)}
          />
        </div>
        <div className="sm:order-3">
          <FilterButton
            count={activeCount}
            expanded={showFilters}
            onClick={() => setShowFilters(true)}
          />
        </div>
      </div>
      <div className="flex gap-2 sm:contents">
        <div className="flex min-w-0 flex-1 sm:order-2 sm:w-64 sm:flex-none">
          <SortMenu
            id="anilistSort"
            value={sort ?? ''}
            groups={groupSorts(anilistSortOptions)}
            labelFor={sortLabel}
            selectedLabel={
              sort
                ? sortLabel(sort)
                : intl.formatMessage(listFilterMessages.listOrder)
            }
            defaultLabel={intl.formatMessage(listFilterMessages.listOrder)}
            onChange={(next) =>
              batchUpdateQueryParams({
                sort: next || undefined,
                order: undefined,
              })
            }
          />
        </div>
        {sort && order && (
          <div className="sm:order-2">
            <SortDirectionButton
              kind={anilistSortOption(sort).kind}
              order={order}
              onChange={(next) => updateQueryParams('order', next)}
            />
          </div>
        )}
      </div>
      <SlideOver
        show={showFilters}
        title={intl.formatMessage(listFilterMessages.filters)}
        subText={intl.formatMessage(listFilterMessages.activeFilters, {
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
            <SectionTitle id="anilistGenresLabel">
              {intl.formatMessage(listFilterMessages.genres)}
            </SectionTitle>
            <Select<{ value: string; label: string }, true>
              inputId="anilistGenres"
              aria-labelledby="anilistGenresLabel"
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
            <SectionTitle
              value={intl.formatMessage(listFilterMessages.rangeText, {
                minValue: yearFrom ?? yearMin,
                maxValue: yearTo ?? yearMax,
              })}
            >
              {intl.formatMessage(listFilterMessages.releaseYear)}
            </SectionTitle>
            <div className="relative z-0">
              <MultiRangeSlider
                label={intl.formatMessage(listFilterMessages.releaseYear)}
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
                    <div className="mb-1 flex items-baseline justify-between gap-2">
                      <span className="font-semibold">{label}</span>
                      <span className="text-sm text-gray-400">
                        {intl.formatMessage(listFilterMessages.rangeText, {
                          minValue: min ?? 0,
                          maxValue: max ?? 100,
                        })}
                      </span>
                    </div>
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
              {intl.formatMessage(listFilterMessages.visibility)}
            </SectionTitle>
            <label
              htmlFor="anilistHideUnmapped"
              className="flex min-h-[44px] cursor-pointer items-center gap-3"
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
              <span>{intl.formatMessage(listFilterMessages.hideUnmapped)}</span>
            </label>
            <p className="ml-9 text-sm text-gray-400">
              {intl.formatMessage(listFilterMessages.hideUnmappedTip)}
            </p>
          </div>
          <div className="pt-2">
            <Button
              className="w-full"
              disabled={activeCount === 0}
              onClick={clearFilters}
            >
              <XCircleIcon />
              <span>{intl.formatMessage(listFilterMessages.clearFilters)}</span>
            </Button>
          </div>
        </div>
      </SlideOver>
    </>
  );
};

export default AnilistListFilters;
