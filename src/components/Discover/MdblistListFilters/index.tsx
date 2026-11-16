import Button from '@app/components/Common/Button';
import MultiRangeSlider from '@app/components/Common/MultiRangeSlider';
import SlideOver from '@app/components/Common/SlideOver';
import {
  ChipGroup,
  DebouncedSearchInput,
  FilterButton,
  listFilterMessages,
  FilterSectionTitle as SectionTitle,
  SortDirectionButton,
  SortMenu,
  splitList,
} from '@app/components/Discover/ListFilterControls';
import {
  groupSorts,
  sortDroppedByMediaType,
} from '@app/components/Discover/listSort';
import type {
  MdblistRatingFilter,
  MdblistSort,
} from '@app/components/Discover/MdblistListFilters/mdblistFilterOptions';
import {
  countMdblistFilters,
  defaultMdblistOrder,
  mdblistClearParams,
  mdblistPrimaryRatings,
  mdblistRatingFilters,
  mdblistRatingScales,
  mdblistSortOption,
  mdblistSortOptions,
  mdblistSorts,
  mdblistYearRange,
  ratingToDisplay,
  ratingToQuery,
  releaseDatesForYears,
  yearOfDate,
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
import {
  ChevronDownIcon,
  ChevronUpIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import Select from 'react-select';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.MdblistListFilters', {
  genresPlaceholder: 'Select genres',
  animeGenres: 'Anime Genres',
  genresLoadFailed: 'Could not load MDBList’s genres.',
  retry: 'Try Again',
  genreAny: 'Any genre picked',
  genreAll: 'Every genre picked',
  genreMatch: 'Genre match',
  ratings: 'Ratings',
  ratingsTip:
    'Each rating uses its site’s own scale. Leave a slider at its full range to skip it.',
  moreRatings: 'More Ratings',
  fewerRatings: 'Fewer Ratings',
  ratingsLocal:
    'Your MDBList plan can’t filter ratings, so Foreseerr checks the first 1,000 titles. The first load may be slow.',
  sortRank: 'List Order',
  sortUsort: 'Owner’s Custom Order',
  sortScore: 'MDBList Score',
  sortScoreAverage: 'Average Rating',
  sortReleased: 'Release Date',
  sortReleaseDigital: 'Digital Release',
  sortAdded: 'Date Added',
  sortImdbRating: 'IMDb Rating',
  sortImdbVotes: 'IMDb Votes',
  sortImdbPopular: 'IMDb Popularity',
  sortTmdbPopular: 'TMDB Popularity',
  sortRogerEbert: 'Roger Ebert Rating',
  sortRtTomatoes: 'RT Tomatometer',
  sortRtAudience: 'RT Audience Score',
  sortMetacritic: 'Metacritic',
  sortMyAnimeList: 'MyAnimeList Score',
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
  ratingRtAudience: 'RT Audience Score',
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
type MediaChoice = 'all' | 'movie' | 'tv';

const queryText = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const queryNumber = (value: unknown) => {
  const text = queryText(value);
  return text === undefined || !Number.isFinite(Number(text))
    ? undefined
    : Number(text);
};

const formatRating = (rating: MdblistRatingFilter, value: number) =>
  mdblistRatingScales[rating].step < 1 ? value.toFixed(1) : String(value);

/**
 * Filters for an MDBList list, mirroring mdblist.com's list toolbar: search
 * and sort in the bar, everything else MDBList's API filters by in the
 * panel. MDBList applies them all, so paging stays complete. Renders the
 * toolbar's controls for `ListFilterHeader`.
 */
const MdblistListFilters = () => {
  const intl = useIntl();
  const query = useRouteQuery();
  const { user } = useUser();
  const updateQueryParams = useUpdateQueryParams({});
  const batchUpdateQueryParams = useBatchUpdateQueryParams({});
  const [showFilters, setShowFilters] = useState(false);
  const [showMoreRatings, setShowMoreRatings] = useState(false);
  // Remounts the sliders after "Clear".
  const [resetKey, setResetKey] = useState(0);
  const { data: discoverDefaults } = useDiscoverFilterDefaults();
  const {
    data: filterData,
    error: filterError,
    mutate: retryFilterData,
  } = useSWR<MdblistFilterData>(
    showFilters ? '/api/v1/discover/mdblist/filters' : null,
    { revalidateOnFocus: false, dedupingInterval: 60 * 60 * 1000 }
  );

  const mediaType =
    query.mediaType === 'movie' || query.mediaType === 'tv'
      ? query.mediaType
      : undefined;
  const sort = mdblistSorts.find((s) => s === query.sort);
  // `rank` is "List Order" reversed: the menu shows both as List Order.
  const menuValue: MdblistSort | '' = !sort || sort === 'rank' ? '' : sort;
  const sortKind = sort ? mdblistSortOption(sort).kind : 'position';
  const order =
    query.order === 'asc' || query.order === 'desc'
      ? query.order
      : sort
        ? defaultMdblistOrder(sort)
        : 'asc';
  const genreMode = query.genreMode === 'and' ? 'and' : 'or';
  const selectedGenres = splitList(query.genres);
  const { min: yearMin, max: yearMax } = mdblistYearRange();
  const yearFrom = yearOfDate(query.releasedFrom);
  const yearTo = yearOfDate(query.releasedTo);
  const hideUnmapped =
    query.hideUnmapped === 'true' ||
    (query.hideUnmapped !== 'false' &&
      !areDiscoverDefaultsCleared(user?.id) &&
      discoverDefaults?.hideUnmapped === true);
  const activeCount = countMdblistFilters(query);
  const secondaryRatings = mdblistRatingFilters.filter(
    (r) => !mdblistPrimaryRatings.includes(r)
  );
  const secondaryRatingSet = secondaryRatings.some(
    (r) => queryText(query[`${r}Min`]) || queryText(query[`${r}Max`])
  );
  const ratingsOpen = showMoreRatings || secondaryRatingSet;

  const sortLabel = (value: MdblistSort) =>
    intl.formatMessage(messages[sortMessages[value]]);
  const genreTitles = new Map(
    (filterData?.genres ?? []).map((g) => [g.slug, g.title])
  );
  const toOption = (g: MdblistGenre): GenreOption => ({
    value: g.slug,
    label: g.title,
  });
  const genreGroups = [
    {
      label: intl.formatMessage(listFilterMessages.genres),
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

  const setMediaType = (next: MediaChoice) => {
    const nextType = next === 'all' ? undefined : next;
    batchUpdateQueryParams({
      mediaType: nextType,
      // A movie-only sort means nothing for shows: drop it with the type.
      ...(sortDroppedByMediaType(mdblistSortOptions, sort, nextType)
        ? { sort: undefined, order: undefined }
        : {}),
    });
  };

  const setDirection = (next: 'asc' | 'desc') => {
    if (!sort || sort === 'rank') {
      // List Order top-first is the plain list; bottom-first is `rank` desc.
      batchUpdateQueryParams(
        next === 'desc'
          ? { sort: 'rank', order: 'desc' }
          : { sort: undefined, order: undefined }
      );
      return;
    }
    updateQueryParams('order', next);
  };

  const clearFilters = () => {
    markDiscoverDefaultsCleared(user?.id);
    batchUpdateQueryParams(mdblistClearParams());
    setResetKey((k) => k + 1);
    setShowMoreRatings(false);
    setShowFilters(false);
  };

  const renderRating = (rating: MdblistRatingFilter) => {
    const minKey = `${rating}Min`;
    const maxKey = `${rating}Max`;
    const scale = mdblistRatingScales[rating];
    const min = queryNumber(query[minKey]);
    const max = queryNumber(query[maxKey]);
    const minValue = min === undefined ? 0 : ratingToDisplay(rating, min);
    const maxValue =
      max === undefined ? scale.max : ratingToDisplay(rating, max);
    const label = intl.formatMessage(messages[ratingMessages[rating]]);
    return (
      <div key={rating}>
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <span className="font-semibold">{label}</span>
          <span className="text-sm text-gray-400">
            {intl.formatMessage(listFilterMessages.rangeText, {
              minValue: formatRating(rating, minValue),
              maxValue: formatRating(rating, maxValue),
            })}
          </span>
        </div>
        <div className="relative z-0">
          <MultiRangeSlider
            label={label}
            min={0}
            max={scale.max}
            step={scale.step}
            defaultMinValue={min === undefined ? undefined : minValue}
            defaultMaxValue={max === undefined ? undefined : maxValue}
            formatValue={(value) => formatRating(rating, value)}
            onUpdateMin={(value) => {
              const score = ratingToQuery(rating, value);
              updateQueryParams(minKey, score > 0 ? String(score) : undefined);
            }}
            onUpdateMax={(value) => {
              const score = ratingToQuery(rating, value);
              updateQueryParams(
                maxKey,
                score < 100 ? String(score) : undefined
              );
            }}
          />
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="flex gap-2 sm:contents">
        <div className="min-w-0 flex-1 sm:order-1 sm:w-56 sm:flex-none">
          <DebouncedSearchInput
            id="mdblistTitle"
            withIcon
            value={queryText(query.title) ?? ''}
            label={intl.formatMessage(listFilterMessages.search)}
            placeholder={intl.formatMessage(
              listFilterMessages.searchPlaceholder
            )}
            onChange={(value) => updateQueryParams('title', value)}
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
            id="mdblistSort"
            value={menuValue}
            groups={groupSorts(mdblistSortOptions, { mediaType })}
            labelFor={sortLabel}
            selectedLabel={sortLabel(sort ?? 'rank')}
            defaultLabel={intl.formatMessage(listFilterMessages.listOrder)}
            onChange={(next) =>
              batchUpdateQueryParams({
                sort: next || undefined,
                order: undefined,
              })
            }
          />
        </div>
        <div className="sm:order-2">
          <SortDirectionButton
            kind={sortKind}
            order={order}
            onChange={setDirection}
          />
        </div>
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
            <SectionTitle>
              {intl.formatMessage(listFilterMessages.contentType)}
            </SectionTitle>
            <ChipGroup<MediaChoice>
              label={intl.formatMessage(listFilterMessages.contentType)}
              multiple={false}
              options={[
                { value: 'all', label: intl.formatMessage(globalMessages.all) },
                {
                  value: 'movie',
                  label: intl.formatMessage(globalMessages.movies),
                },
                {
                  value: 'tv',
                  label: intl.formatMessage(globalMessages.tvshows),
                },
              ]}
              selected={[mediaType ?? 'all']}
              onChange={(picked) => setMediaType(picked[0] ?? 'all')}
            />
          </div>
          <div>
            <SectionTitle id="mdblistGenresLabel">
              {intl.formatMessage(listFilterMessages.genres)}
            </SectionTitle>
            {filterError && !filterData ? (
              <div className="flex items-center justify-between gap-3 rounded-md border border-gray-700 p-3 text-sm text-gray-300">
                <span>{intl.formatMessage(messages.genresLoadFailed)}</span>
                <Button
                  buttonSize="sm"
                  className="min-h-[44px]"
                  onClick={() => retryFilterData()}
                >
                  {intl.formatMessage(messages.retry)}
                </Button>
              </div>
            ) : (
              <Select<GenreOption, true>
                inputId="mdblistGenres"
                aria-labelledby="mdblistGenresLabel"
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
                    value.length
                      ? value.map((v) => v.value).join(',')
                      : undefined
                  )
                }
              />
            )}
            {selectedGenres.length >= 2 && (
              <div className="mt-2">
                <ChipGroup
                  label={intl.formatMessage(messages.genreMatch)}
                  multiple={false}
                  options={[
                    {
                      value: 'or',
                      label: intl.formatMessage(messages.genreAny),
                    },
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
            )}
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
                    'releasedFrom',
                    releaseDatesForYears(value > yearMin ? value : undefined)
                      .releasedFrom
                  )
                }
                onUpdateMax={(value) =>
                  updateQueryParams(
                    'releasedTo',
                    releaseDatesForYears(
                      undefined,
                      value < yearMax ? value : undefined
                    ).releasedTo
                  )
                }
              />
            </div>
          </div>
          <div>
            <SectionTitle>{intl.formatMessage(messages.ratings)}</SectionTitle>
            <div className="flex flex-col space-y-5">
              <p className="text-sm text-gray-400">
                {intl.formatMessage(messages.ratingsTip)}
              </p>
              {mdblistPrimaryRatings.map(renderRating)}
              {ratingsOpen && secondaryRatings.map(renderRating)}
              {!secondaryRatingSet && (
                <Button
                  buttonType="ghost"
                  className="min-h-[44px] self-start"
                  aria-expanded={ratingsOpen}
                  onClick={() => setShowMoreRatings((open) => !open)}
                >
                  {ratingsOpen ? <ChevronUpIcon /> : <ChevronDownIcon />}
                  <span>
                    {intl.formatMessage(
                      ratingsOpen ? messages.fewerRatings : messages.moreRatings
                    )}
                  </span>
                </Button>
              )}
              {filterData?.supporter === false ||
              filterData?.supporter === null ? (
                <p className="text-sm text-gray-400">
                  {intl.formatMessage(messages.ratingsLocal)}
                </p>
              ) : null}
            </div>
          </div>
          <div>
            <SectionTitle>
              {intl.formatMessage(listFilterMessages.visibility)}
            </SectionTitle>
            <label
              htmlFor="mdblistHideUnmapped"
              className="flex min-h-[44px] cursor-pointer items-center gap-3"
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

export default MdblistListFilters;
