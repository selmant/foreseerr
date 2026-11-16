import Button from '@app/components/Common/Button';
import MultiRangeSlider from '@app/components/Common/MultiRangeSlider';
import SlideOver from '@app/components/Common/SlideOver';
import {
  ChipGroup,
  DebouncedSearchInput,
  FilterSectionTitle as SectionTitle,
  SortDirectionButton,
  splitList,
} from '@app/components/Discover/ListFilterControls';
import type {
  MdblistRatingFilter,
  MdblistSort,
} from '@app/components/Discover/MdblistListFilters/mdblistFilterOptions';
import {
  countMdblistFilters,
  defaultMdblistOrder,
  mdblistPanelKeys,
  mdblistRatingFilters,
  mdblistSorts,
} from '@app/components/Discover/MdblistListFilters/mdblistFilterOptions';
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
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { XCircleIcon } from '@heroicons/react/24/outline';
import { FunnelIcon } from '@heroicons/react/24/solid';
import Datepicker from '@seerr-team/react-tailwindcss-datepicker';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import Select from 'react-select';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.MdblistListFilters', {
  contentType: 'Content type',
  shows: 'Shows',
  sortLabel: 'Sort',
  sortDefault: 'List Order',
  filters: 'MDBList Filters',
  filtersTip:
    'MDBList filters the list itself, so every page holds matching titles.',
  activefilters:
    '{count, plural, one {# Active Filter} other {# Active Filters}}',
  title: 'Title',
  titlePlaceholder: 'Titles containing…',
  genres: 'Genres',
  genresPlaceholder: 'Search MDBList genres',
  animeGenres: 'Anime genres',
  genreAny: 'Any genre',
  genreAll: 'All genres',
  releaseDate: 'Release Date',
  from: 'From',
  to: 'To',
  ratings: 'Ratings',
  ratingsTip:
    'MDBList scores every source from 0 to 100. Leave a slider at its full range to skip that rating.',
  ratingsLocal:
    'Your MDBList account is not a confirmed supporter, so Foreseerr checks these ratings itself. It reads up to the first 1,000 titles of the list, so pages can take a moment the first time.',
  ratingText: '{label} between {minValue} and {maxValue}',
  visibility: 'Visibility',
  hideUnmapped: 'Hide Unmapped Titles',
  hideUnmappedTip: 'Hide titles that could not be mapped to TMDB.',
  clearfilters: 'Clear Active Filters',
  sortRank: 'Rank',
  sortUsort: 'User Sort',
  sortScore: 'Score',
  sortScoreAverage: 'Average Score',
  sortReleased: 'Release Date',
  sortReleaseDigital: 'Digital Release',
  sortAdded: 'Date Added',
  sortImdbRating: 'IMDb Rating',
  sortImdbVotes: 'IMDb Votes',
  sortImdbPopular: 'IMDb Popularity',
  sortTmdbPopular: 'TMDB Popularity',
  sortRogerEbert: 'Roger Ebert',
  sortRtTomatoes: 'RT Tomatometer',
  sortRtAudience: 'RT Audience',
  sortMetacritic: 'Metacritic',
  sortMyAnimeList: 'MyAnimeList',
  sortLetterRating: 'Letterboxd Rating',
  sortLetterVotes: 'Letterboxd Votes',
  sortLastAirDate: 'Last Air Date',
  sortBudget: 'Budget',
  sortRevenue: 'Revenue',
  sortRuntime: 'Runtime',
  sortTitle: 'Title',
  sortSortTitle: 'Sort Title',
  ratingScore: 'MDBList Score',
  ratingImdbRating: 'IMDb',
  ratingTmdbRating: 'TMDB',
  ratingMetacritic: 'Metacritic',
  ratingRtCritics: 'RT Tomatometer',
  ratingRtAudience: 'RT Audience',
  ratingLetterboxd: 'Letterboxd',
  ratingMal: 'MyAnimeList',
});

const sortMessages: Record<MdblistSort, keyof typeof messages> = {
  rank: 'sortRank',
  usort: 'sortUsort',
  score: 'sortScore',
  score_average: 'sortScoreAverage',
  released: 'sortReleased',
  releasedigital: 'sortReleaseDigital',
  added: 'sortAdded',
  imdbrating: 'sortImdbRating',
  imdbvotes: 'sortImdbVotes',
  imdbpopular: 'sortImdbPopular',
  tmdbpopular: 'sortTmdbPopular',
  rogerebert: 'sortRogerEbert',
  rtomatoes: 'sortRtTomatoes',
  rtaudience: 'sortRtAudience',
  metacritic: 'sortMetacritic',
  myanimelist: 'sortMyAnimeList',
  letterrating: 'sortLetterRating',
  lettervotes: 'sortLetterVotes',
  last_air_date: 'sortLastAirDate',
  budget: 'sortBudget',
  revenue: 'sortRevenue',
  runtime: 'sortRuntime',
  title: 'sortTitle',
  sort_title: 'sortSortTitle',
};

const ratingMessages: Record<MdblistRatingFilter, keyof typeof messages> = {
  score: 'ratingScore',
  imdbRating: 'ratingImdbRating',
  tmdbRating: 'ratingTmdbRating',
  metacritic: 'ratingMetacritic',
  rtCritics: 'ratingRtCritics',
  rtAudience: 'ratingRtAudience',
  letterboxd: 'ratingLetterboxd',
  mal: 'ratingMal',
};

type MdblistGenre = { slug: string; title: string; anime: boolean };
type MdblistFilterData = {
  genres: MdblistGenre[];
  supporter: boolean | null;
};
type GenreOption = { value: string; label: string };

const queryText = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * Filters for an MDBList list, mirroring mdblist.com's list toolbar: content
 * type and sort up front, everything else MDBList's API filters by in the
 * panel. MDBList applies them all, so paging stays complete.
 */
const MdblistListFilters = () => {
  const intl = useIntl();
  const query = useRouteQuery();
  const { user } = useUser();
  const updateQueryParams = useUpdateQueryParams({});
  const batchUpdateQueryParams = useBatchUpdateQueryParams({});
  const [showFilters, setShowFilters] = useState(false);
  // Remounts the sliders and title box after "Clear".
  const [resetKey, setResetKey] = useState(0);
  const { data: discoverDefaults } = useDiscoverFilterDefaults();
  const { data: filterData } = useSWR<MdblistFilterData>(
    showFilters ? '/api/v1/discover/mdblist/filters' : null,
    { revalidateOnFocus: false, dedupingInterval: 60 * 60 * 1000 }
  );

  const mediaType =
    query.mediaType === 'movie' || query.mediaType === 'tv'
      ? query.mediaType
      : '';
  const sort = mdblistSorts.find((s) => s === query.sort);
  const order =
    query.order === 'asc' || query.order === 'desc'
      ? query.order
      : sort
        ? defaultMdblistOrder(sort)
        : undefined;
  const genreMode = query.genreMode === 'and' ? 'and' : 'or';
  const selectedGenres = splitList(query.genres);
  const hideUnmapped =
    query.hideUnmapped === 'true' ||
    (query.hideUnmapped !== 'false' &&
      !areDiscoverDefaultsCleared(user?.id) &&
      discoverDefaults?.hideUnmapped === true);
  const activeCount = countMdblistFilters(query);

  const genreTitles = new Map(
    (filterData?.genres ?? []).map((g) => [g.slug, g.title])
  );
  const toOption = (g: MdblistGenre): GenreOption => ({
    value: g.slug,
    label: g.title,
  });
  const genreGroups = [
    {
      label: intl.formatMessage(messages.genres),
      options: (filterData?.genres ?? []).filter((g) => !g.anime).map(toOption),
    },
    {
      label: intl.formatMessage(messages.animeGenres),
      options: (filterData?.genres ?? []).filter((g) => g.anime).map(toOption),
    },
  ].filter((group) => group.options.length > 0);
  const selectedOptions: GenreOption[] = selectedGenres.map((slug) => ({
    value: slug,
    label: genreTitles.get(slug) ?? slug,
  }));

  const clearFilters = () => {
    markDiscoverDefaultsCleared(user?.id);
    batchUpdateQueryParams({
      ...Object.fromEntries(mdblistPanelKeys.map((k) => [k, undefined])),
      hideUnmapped: 'false',
    });
    setResetKey((k) => k + 1);
    setShowFilters(false);
  };

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="w-full min-w-0 sm:w-48">
        <label
          htmlFor="mdblistMediaType"
          className="mb-1 block text-sm text-gray-300"
        >
          {intl.formatMessage(messages.contentType)}
        </label>
        <select
          id="mdblistMediaType"
          className="min-h-[44px] w-full"
          value={mediaType}
          onChange={(e) =>
            updateQueryParams('mediaType', e.target.value || undefined)
          }
        >
          <option value="">{intl.formatMessage(globalMessages.all)}</option>
          <option value="movie">
            {intl.formatMessage(globalMessages.movies)}
          </option>
          <option value="tv">{intl.formatMessage(messages.shows)}</option>
        </select>
      </div>
      <div className="flex w-full min-w-0 items-end gap-2 sm:w-72">
        <div className="min-w-0 flex-1">
          <label
            htmlFor="mdblistSort"
            className="mb-1 block text-sm text-gray-300"
          >
            {intl.formatMessage(messages.sortLabel)}
          </label>
          <select
            id="mdblistSort"
            className="min-h-[44px] w-full"
            value={sort ?? ''}
            onChange={(e) => {
              const next = mdblistSorts.find((s) => s === e.target.value);
              batchUpdateQueryParams({
                sort: next,
                order: next ? defaultMdblistOrder(next) : undefined,
              });
            }}
          >
            <option value="">{intl.formatMessage(messages.sortDefault)}</option>
            {mdblistSorts.map((s) => (
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
          <p className="text-sm text-gray-400">
            {intl.formatMessage(messages.filtersTip)}
          </p>
          <div>
            <SectionTitle>
              <label htmlFor="mdblistTitle">
                {intl.formatMessage(messages.title)}
              </label>
            </SectionTitle>
            <DebouncedSearchInput
              id="mdblistTitle"
              value={queryText(query.title) ?? ''}
              placeholder={intl.formatMessage(messages.titlePlaceholder)}
              onChange={(value) => updateQueryParams('title', value)}
            />
          </div>
          <div>
            <SectionTitle>{intl.formatMessage(messages.genres)}</SectionTitle>
            <Select<GenreOption, true>
              aria-label={intl.formatMessage(messages.genresPlaceholder)}
              className="react-select-container"
              classNamePrefix="react-select"
              isMulti
              isLoading={!filterData}
              options={genreGroups}
              value={selectedOptions}
              placeholder={intl.formatMessage(messages.genresPlaceholder)}
              onChange={(value) =>
                updateQueryParams(
                  'genres',
                  value.length ? value.map((v) => v.value).join(',') : undefined
                )
              }
            />
            <div className="mt-2">
              <ChipGroup
                label={intl.formatMessage(messages.genres)}
                multiple={false}
                disabled={selectedGenres.length < 2}
                options={[
                  { value: 'or', label: intl.formatMessage(messages.genreAny) },
                  {
                    value: 'and',
                    label: intl.formatMessage(messages.genreAll),
                  },
                ]}
                selected={[genreMode]}
                onChange={(picked) =>
                  updateQueryParams(
                    'genreMode',
                    picked[0] === 'and' ? 'and' : undefined
                  )
                }
              />
            </div>
          </div>
          <div>
            <SectionTitle>
              {intl.formatMessage(messages.releaseDate)}
            </SectionTitle>
            <div className="relative z-40 flex space-x-2">
              {(
                [
                  ['releasedFrom', messages.from, 'mdblistFrom'],
                  ['releasedTo', messages.to, 'mdblistTo'],
                ] as const
              ).map(([key, label, inputName]) => (
                <div className="flex flex-col" key={key}>
                  <div className="mb-2">{intl.formatMessage(label)}</div>
                  <Datepicker
                    primaryColor="indigo"
                    value={{
                      startDate: queryText(query[key]) ?? null,
                      endDate: queryText(query[key]) ?? null,
                    }}
                    onChange={(value) =>
                      updateQueryParams(
                        key,
                        value?.startDate
                          ? (value.startDate as string)
                          : undefined
                      )
                    }
                    inputName={inputName}
                    useRange={false}
                    asSingle
                    containerClassName="datepicker-wrapper"
                    inputClassName="pr-1 sm:pr-4 text-base leading-5"
                  />
                </div>
              ))}
            </div>
          </div>
          <div>
            <SectionTitle>{intl.formatMessage(messages.ratings)}</SectionTitle>
            <div className="flex flex-col space-y-4">
              <p className="text-sm text-gray-400">
                {intl.formatMessage(messages.ratingsTip)}
              </p>
              {filterData && filterData.supporter !== true && (
                <p className="text-sm text-gray-400">
                  {intl.formatMessage(messages.ratingsLocal)}
                </p>
              )}
              {mdblistRatingFilters.map((rating) => {
                const minKey = `${rating}Min`;
                const maxKey = `${rating}Max`;
                const min = queryText(query[minKey]);
                const max = queryText(query[maxKey]);
                const label = intl.formatMessage(
                  messages[ratingMessages[rating]]
                );
                return (
                  <div key={rating}>
                    <div className="mb-1 font-semibold">{label}</div>
                    <div className="relative z-0">
                      <MultiRangeSlider
                        label={label}
                        min={0}
                        max={100}
                        defaultMinValue={min ? Number(min) : undefined}
                        defaultMaxValue={max ? Number(max) : undefined}
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
                        subText={intl.formatMessage(messages.ratingText, {
                          label,
                          minValue: min ?? 0,
                          maxValue: max ?? 100,
                        })}
                      />
                    </div>
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
              htmlFor="mdblistHideUnmapped"
              className="flex cursor-pointer items-center gap-3"
            >
              <input
                type="checkbox"
                id="mdblistHideUnmapped"
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

export default MdblistListFilters;
