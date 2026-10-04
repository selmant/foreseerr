import Button from '@app/components/Common/Button';
import FilterSlideover, {
  browseFilterCapabilities,
} from '@app/components/Discover/FilterSlideover';
import {
  countActiveFilters,
  prepareFilterValues,
} from '@app/components/Discover/constants';
import { mergeFilterDefaults } from '@app/components/Discover/mergeFilterDefaults';
import { useDiscoverFilterDefaults } from '@app/hooks/useDiscoverFilterDefaults';
import useRouteQuery from '@app/hooks/useRouteQuery';
import { useUpdateQueryParams } from '@app/hooks/useUpdateQueryParams';
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
  activefilters:
    '{count, plural, one {# Active Filter} other {# Active Filters}}',
});

type TraktMediaType = 'all' | 'movie' | 'tv' | 'anime';

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
  const currentSort =
    query.sort === 'added' || query.sort === 'released' ? query.sort : '';

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
        <div className="w-full min-w-0 sm:w-64">
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
            onChange={(e) =>
              updateQueryParams('sort', e.target.value || undefined)
            }
          >
            <option value="">{intl.formatMessage(messages.traktOrder)}</option>
            <option value="added">
              {intl.formatMessage(messages.dateAdded)}
            </option>
            <option value="released">
              {intl.formatMessage(messages.releaseDate)}
            </option>
          </select>
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
