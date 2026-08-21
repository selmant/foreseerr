import Button from '@app/components/Common/Button';
import {
  countActiveFilters,
  prepareFilterValues,
} from '@app/components/Discover/constants';
import FilterSlideover, {
  browseFilterCapabilities,
} from '@app/components/Discover/FilterSlideover';
import { mergeFilterDefaults } from '@app/components/Discover/mergeFilterDefaults';
import { useDiscoverFilterDefaults } from '@app/hooks/useDiscoverFilterDefaults';
import { useUpdateQueryParams } from '@app/hooks/useUpdateQueryParams';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { CircleStackIcon, FunnelIcon } from '@heroicons/react/24/solid';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.TraktDiscoverFilters', {
  anime: 'Anime',
  sortLabel: 'Sort',
  traktOrder: 'Trakt list order',
  dateAdded: 'Date added (newest first)',
  releaseDate: 'Release date (newest first)',
  activefilters:
    '{count, plural, one {# Active Filter} other {# Active Filters}}',
});

type TraktMediaType = 'all' | 'movie' | 'tv' | 'anime';

interface TraktDiscoverFiltersProps {
  showRecommendationFilters?: boolean;
  showHideWatchedFilter?: boolean;
}

const TraktDiscoverFilters = ({
  showRecommendationFilters = false,
  showHideWatchedFilter = true,
}: TraktDiscoverFiltersProps) => {
  const intl = useIntl();
  const router = useRouter();
  const { user } = useUser();
  const updateQueryParams = useUpdateQueryParams({});
  const [showFilters, setShowFilters] = useState(false);
  const { data: discoverDefaults } = useDiscoverFilterDefaults();
  const preparedFilters = mergeFilterDefaults(
    prepareFilterValues(router.query),
    discoverDefaults,
    user?.id
  );

  const currentType: TraktMediaType =
    router.query.type === 'movie' ||
    router.query.type === 'tv' ||
    router.query.type === 'anime'
      ? router.query.type
      : 'all';

  const filterType: 'movie' | 'tv' = currentType === 'tv' ? 'tv' : 'movie';
  const genreType: 'movie' | 'tv' | 'all' =
    currentType === 'movie' || currentType === 'tv' ? currentType : 'all';
  const currentSort =
    router.query.sort === 'added' || router.query.sort === 'released'
      ? router.query.sort
      : '';

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
    <div className="mt-2 flex flex-grow flex-col sm:flex-row lg:flex-grow-0">
      <div className="mb-2 flex flex-grow sm:mb-0 sm:mr-2 lg:flex-grow-0">
        <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-sm text-gray-100">
          <CircleStackIcon className="h-6 w-6" />
        </span>
        <select
          id="traktMediaType"
          name="traktMediaType"
          className="rounded-r-only"
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
      <div className="mb-2 flex flex-grow sm:mb-0 sm:mr-2 lg:flex-grow-0">
        <label htmlFor="traktListSort" className="sr-only">
          {intl.formatMessage(messages.sortLabel)}
        </label>
        <select
          id="traktListSort"
          name="traktListSort"
          className="rounded-md"
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
      <div className="mb-2 flex flex-grow sm:mb-0 lg:flex-grow-0">
        <Button onClick={() => setShowFilters(true)} className="w-full">
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
