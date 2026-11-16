import Button from '@app/components/Common/Button';
import FilterSlideover, {
  browseFilterCapabilities,
} from '@app/components/Discover/FilterSlideover';
import { SortDirectionButton } from '@app/components/Discover/ListFilterControls';
import {
  countActiveFilters,
  prepareFilterValues,
} from '@app/components/Discover/constants';
import { mergeFilterDefaults } from '@app/components/Discover/mergeFilterDefaults';
import { useDiscoverFilterDefaults } from '@app/hooks/useDiscoverFilterDefaults';
import useRouteQuery from '@app/hooks/useRouteQuery';
import {
  useBatchUpdateQueryParams,
  useUpdateQueryParams,
} from '@app/hooks/useUpdateQueryParams';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { FunnelIcon } from '@heroicons/react/24/solid';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.TraktDiscoverFilters', {
  anime: 'Anime',
  contentType: 'Content type',
  sortLabel: 'Sort',
  traktOrder: 'Trakt List Order',
  dateAdded: 'Date Added Descending',
  releaseDate: 'Release Date Descending',
  vipSort: '{label} (VIP)',
  sortRank: 'Rank',
  sortAdded: 'Recently Added',
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
  sortRtAudience: 'RT Audience',
  sortMetascore: 'Metascore',
  sortMyRating: 'My Rating',
  sortWatched: 'Watched',
  sortCollected: 'Collected',
  activefilters:
    '{count, plural, one {# Active Filter} other {# Active Filters}}',
});

type TraktMediaType = 'all' | 'movie' | 'tv' | 'anime';

/** Trakt's list sorts (`sort_by`), as trakt.tv's list menu offers them. */
const traktListSorts = [
  { value: 'rank', label: 'sortRank' },
  { value: 'added', label: 'sortAdded' },
  { value: 'title', label: 'sortTitle' },
  { value: 'released', label: 'sortReleased' },
  { value: 'runtime', label: 'sortRuntime' },
  { value: 'popularity', label: 'sortPopularity' },
  { value: 'percentage', label: 'sortPercentage' },
  { value: 'votes', label: 'sortVotes' },
  { value: 'imdb_rating', label: 'sortImdbRating', vip: true },
  { value: 'imdb_votes', label: 'sortImdbVotes', vip: true },
  { value: 'tmdb_rating', label: 'sortTmdbRating', vip: true },
  { value: 'tmdb_votes', label: 'sortTmdbVotes', vip: true },
  { value: 'rt_tomatometer', label: 'sortRtTomatometer', vip: true },
  { value: 'rt_audience', label: 'sortRtAudience', vip: true },
  { value: 'metascore', label: 'sortMetascore', vip: true },
  { value: 'my_rating', label: 'sortMyRating' },
  { value: 'watched', label: 'sortWatched' },
  { value: 'collected', label: 'sortCollected' },
] as const satisfies readonly {
  value: string;
  label: keyof typeof messages;
  vip?: boolean;
}[];

/** Rank and title read A→Z; dates, ratings, and counts high→low. */
const defaultTraktSortHow = (sort: string) =>
  sort === 'rank' || sort === 'title' ? 'asc' : 'desc';

/** A watchlist link reads Trakt's watchlist, which only sorts by date. */
const isWatchlistUrl = (url: unknown) =>
  typeof url === 'string' && /\/watchlist\/?(?:[?#]|$)/.test(url);

interface TraktDiscoverFiltersProps {
  showRecommendationFilters?: boolean;
  showHideWatchedFilter?: boolean;
  showListSort?: boolean;
}

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
  const currentSort =
    typeof query.sort === 'string' &&
    (watchlistSort
      ? query.sort === 'added' || query.sort === 'released'
      : traktListSorts.some((s) => s.value === query.sort))
      ? query.sort
      : '';
  // A direction makes Trakt order the whole list; links from before it was
  // offered (`added` / `released` alone) keep their newest-first sort.
  const sortHow =
    query.sortHow === 'asc' || query.sortHow === 'desc'
      ? query.sortHow
      : currentSort
        ? 'desc'
        : undefined;

  const activeFilterCount =
    countActiveFilters(preparedFilters) +
    (showHideWatchedFilter &&
    (preparedFilters.ignoreWatched === 'true' ||
      preparedFilters.ignoreWatched === 'false')
      ? 1
      : 0) +
    (showRecommendationFilters && preparedFilters.ignoreCollected === 'true'
      ? 1
      : 0) +
    (showRecommendationFilters && preparedFilters.ignoreWatchlisted === 'true'
      ? 1
      : 0) +
    (preparedFilters.hideUnmapped === 'true' ||
    preparedFilters.hideUnmapped === 'false'
      ? 1
      : 0);

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="w-full min-w-0 sm:w-48">
        <label
          htmlFor="traktMediaType"
          className="mb-1 block text-sm text-gray-300"
        >
          {intl.formatMessage(messages.contentType)}
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
          <option value="all">{intl.formatMessage(globalMessages.all)}</option>
          <option value="movie">
            {intl.formatMessage(globalMessages.movies)}
          </option>
          <option value="tv">
            {intl.formatMessage(globalMessages.tvshows)}
          </option>
          <option value="anime">{intl.formatMessage(messages.anime)}</option>
        </select>
      </div>
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
      {showListSort && (
        <div className="flex w-full min-w-0 items-end gap-2 sm:w-72">
          <div className="min-w-0 flex-1">
            <label
              htmlFor="traktListSort"
              className="mb-1 block text-sm text-gray-300"
            >
              {intl.formatMessage(messages.sortLabel)}
            </label>
            <select
              id="traktListSort"
              name="traktListSort"
              className="min-h-[44px] w-full"
              value={currentSort}
              onChange={(e) => {
                const next = e.target.value || undefined;
                batchUpdateQueryParams({
                  sort: next,
                  sortHow:
                    next && !watchlistSort
                      ? defaultTraktSortHow(next)
                      : undefined,
                });
              }}
            >
              <option value="">
                {intl.formatMessage(messages.traktOrder)}
              </option>
              {watchlistSort ? (
                <>
                  <option value="added">
                    {intl.formatMessage(messages.dateAdded)}
                  </option>
                  <option value="released">
                    {intl.formatMessage(messages.releaseDate)}
                  </option>
                </>
              ) : (
                traktListSorts.map((sort) => {
                  const label = intl.formatMessage(messages[sort.label]);
                  return (
                    <option key={sort.value} value={sort.value}>
                      {'vip' in sort && sort.vip
                        ? intl.formatMessage(messages.vipSort, { label })
                        : label}
                    </option>
                  );
                })
              )}
            </select>
          </div>
          {!watchlistSort && (
            <SortDirectionButton
              order={sortHow}
              disabled={!currentSort}
              onChange={(next) => updateQueryParams('sortHow', next)}
            />
          )}
        </div>
      )}
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
              count: activeFilterCount,
            })}
          </span>
        </Button>
      </div>
    </div>
  );
};

export default TraktDiscoverFilters;
