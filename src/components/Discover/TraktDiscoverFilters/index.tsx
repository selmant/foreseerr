import { prepareFilterValues } from '@app/components/Discover/constants';
import FilterSlideover, {
  browseFilterCapabilities,
} from '@app/components/Discover/FilterSlideover';
import {
  FilterButton,
  listFilterMessages,
  SortDirectionButton,
  SortMenu,
} from '@app/components/Discover/ListFilterControls';
import {
  groupSorts,
  sortAvailability,
} from '@app/components/Discover/listSort';
import { mergeFilterDefaults } from '@app/components/Discover/mergeFilterDefaults';
import type { TraktListSort } from '@app/components/Discover/TraktDiscoverFilters/traktListOptions';
import {
  countTraktFilters,
  defaultTraktSortHow,
  isWatchlistUrl,
  traktListSortOptions,
  traktSortOption,
  traktWatchlistSortOptions,
} from '@app/components/Discover/TraktDiscoverFilters/traktListOptions';
import { useDiscoverFilterDefaults } from '@app/hooks/useDiscoverFilterDefaults';
import useRouteQuery from '@app/hooks/useRouteQuery';
import {
  useBatchUpdateQueryParams,
  useUpdateQueryParams,
} from '@app/hooks/useUpdateQueryParams';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.TraktDiscoverFilters', {
  anime: 'Anime',
  watchlistAdded: 'Date Added (Newest First)',
  watchlistReleased: 'Release Date (Newest First)',
  needsVip: '{label} (needs Trakt VIP)',
  sortRank: 'List Position',
  sortAdded: 'Date Added',
  sortTitle: 'Title',
  sortReleased: 'Release Date',
  sortRuntime: 'Runtime',
  sortPopularity: 'Popularity',
  sortPercentage: 'Trakt Rating',
  sortVotes: 'Trakt Votes',
  sortImdbRating: 'IMDb Rating',
  sortImdbVotes: 'IMDb Votes',
  sortTmdbRating: 'TMDB Rating',
  sortTmdbVotes: 'TMDB Votes',
  sortRtTomatometer: 'RT Tomatometer',
  sortRtAudience: 'RT Audience Score',
  sortMetascore: 'Metascore',
  sortMyRating: 'Your Rating',
  sortWatched: 'Watched',
  sortCollected: 'Collected',
});

const sortMessages: Record<TraktListSort, keyof typeof messages> = {
  rank: 'sortRank',
  added: 'sortAdded',
  title: 'sortTitle',
  released: 'sortReleased',
  runtime: 'sortRuntime',
  popularity: 'sortPopularity',
  percentage: 'sortPercentage',
  votes: 'sortVotes',
  imdb_rating: 'sortImdbRating',
  imdb_votes: 'sortImdbVotes',
  tmdb_rating: 'sortTmdbRating',
  tmdb_votes: 'sortTmdbVotes',
  rt_tomatometer: 'sortRtTomatometer',
  rt_audience: 'sortRtAudience',
  metascore: 'sortMetascore',
  my_rating: 'sortMyRating',
  watched: 'sortWatched',
  collected: 'sortCollected',
};

type TraktMediaType = 'all' | 'movie' | 'tv' | 'anime';
type TraktAccount = { linked: boolean; vip: boolean | null };

interface TraktDiscoverFiltersProps {
  showRecommendationFilters?: boolean;
  showHideWatchedFilter?: boolean;
  showListSort?: boolean;
}

/** The Trakt pages' toolbar controls, for `ListFilterHeader`. */
const TraktDiscoverFilters = ({
  showRecommendationFilters = false,
  showHideWatchedFilter = true,
  showListSort = false,
}: TraktDiscoverFiltersProps) => {
  const intl = useIntl();
  const query = useRouteQuery();
  const { user } = useUser();
  const updateQueryParams = useUpdateQueryParams({});
  const batchUpdateQueryParams = useBatchUpdateQueryParams({});
  const [showFilters, setShowFilters] = useState(false);
  const { data: discoverDefaults } = useDiscoverFilterDefaults();
  const preparedFilters = mergeFilterDefaults(
    prepareFilterValues(query),
    discoverDefaults,
    user?.id
  );

  const currentType: TraktMediaType =
    query.type === 'movie' || query.type === 'tv' || query.type === 'anime'
      ? query.type
      : 'all';

  const filterType: 'movie' | 'tv' = currentType === 'tv' ? 'tv' : 'movie';
  const genreType: 'movie' | 'tv' | 'all' =
    currentType === 'movie' || currentType === 'tv' ? currentType : 'all';
  const watchlistSort = isWatchlistUrl(query.url);
  // Which list sorts this account can use: VIP ones and personal ones.
  const { data: account } = useSWR<TraktAccount>(
    showListSort && !watchlistSort ? '/api/v1/discover/trakt/account' : null,
    { revalidateOnFocus: false, dedupingInterval: 10 * 60 * 1000 }
  );
  const sortOptions = watchlistSort
    ? traktWatchlistSortOptions
    : traktListSortOptions;
  const currentSort = (
    typeof query.sort === 'string' &&
    sortOptions.some((s) => s.value === query.sort)
      ? query.sort
      : ''
  ) as TraktListSort | '';
  // Without a direction the backend picks the sort's default (A→Z for rank
  // and title, high→low otherwise; legacy `added` / `released` newest first).
  const sortHow =
    query.sortHow === 'asc' || query.sortHow === 'desc'
      ? query.sortHow
      : currentSort
        ? defaultTraktSortHow(currentSort)
        : 'asc';
  const sortContext = {
    mediaType: genreType === 'all' ? undefined : genreType,
    linked: account?.linked,
    vip: account?.vip,
  };

  const activeFilterCount = countTraktFilters(preparedFilters, {
    showHideWatched: showHideWatchedFilter,
    showRecommendationFilters,
  });

  const sortLabel = (value: TraktListSort) => {
    if (watchlistSort) {
      return intl.formatMessage(
        value === 'released'
          ? messages.watchlistReleased
          : messages.watchlistAdded
      );
    }
    return intl.formatMessage(messages[sortMessages[value]]);
  };
  const currentOption = currentSort ? traktSortOption(currentSort) : undefined;
  const selectedLabel = !currentSort
    ? intl.formatMessage(listFilterMessages.listOrder)
    : currentOption &&
        !watchlistSort &&
        sortAvailability(currentOption, sortContext) === 'needsVip'
      ? intl.formatMessage(messages.needsVip, {
          label: sortLabel(currentSort),
        })
      : sortLabel(currentSort);

  return (
    <>
      <div className="flex gap-2 sm:contents">
        <div className="min-w-0 flex-1 sm:order-1 sm:w-44 sm:flex-none">
          <label htmlFor="traktMediaType" className="sr-only">
            {intl.formatMessage(listFilterMessages.contentType)}
          </label>
          <select
            id="traktMediaType"
            name="traktMediaType"
            className="min-h-[44px] w-full"
            value={currentType}
            onChange={(e) => {
              const value = e.target.value as TraktMediaType;
              updateQueryParams('type', value === 'all' ? undefined : value);
            }}
          >
            <option value="all">
              {intl.formatMessage(globalMessages.all)}
            </option>
            <option value="movie">
              {intl.formatMessage(globalMessages.movies)}
            </option>
            <option value="tv">
              {intl.formatMessage(globalMessages.tvshows)}
            </option>
            <option value="anime">{intl.formatMessage(messages.anime)}</option>
          </select>
        </div>
        <div className="sm:order-3">
          <FilterButton
            count={activeFilterCount}
            expanded={showFilters}
            onClick={() => setShowFilters(true)}
          />
        </div>
      </div>
      {showListSort && (
        <div className="flex gap-2 sm:contents">
          <div className="flex min-w-0 flex-1 sm:order-2 sm:w-64 sm:flex-none">
            <SortMenu<TraktListSort>
              id="traktListSort"
              value={currentSort}
              groups={groupSorts<TraktListSort>(
                sortOptions as readonly (typeof traktListSortOptions)[number][],
                sortContext
              )}
              labelFor={sortLabel}
              selectedLabel={selectedLabel}
              defaultLabel={intl.formatMessage(listFilterMessages.listOrder)}
              onChange={(next) =>
                batchUpdateQueryParams({
                  sort: next || undefined,
                  sortHow:
                    next && !watchlistSort
                      ? defaultTraktSortHow(next)
                      : undefined,
                })
              }
            />
          </div>
          {currentOption && !watchlistSort && (
            <div className="sm:order-2">
              <SortDirectionButton
                kind={currentOption.kind}
                order={sortHow}
                onChange={(next) => updateQueryParams('sortHow', next)}
              />
            </div>
          )}
        </div>
      )}
      <FilterSlideover
        type={filterType}
        genreType={genreType}
        capabilities={browseFilterCapabilities}
        showHideWatched={showHideWatchedFilter}
        showHideUnmapped
        showTraktRecommendationFilters={showRecommendationFilters}
        currentFilters={preparedFilters}
        onClose={() => setShowFilters(false)}
        show={showFilters}
      />
    </>
  );
};

export default TraktDiscoverFilters;
