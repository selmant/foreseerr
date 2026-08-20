import Button from '@app/components/Common/Button';
import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import {
  countActiveFilters,
  prepareFilterValues,
} from '@app/components/Discover/constants';
import FilterSlideover, {
  browseFilterCapabilities,
} from '@app/components/Discover/FilterSlideover';
import {
  discoverDefaultsRequestExtras,
  mergeFilterDefaults,
} from '@app/components/Discover/mergeFilterDefaults';
import useDiscover from '@app/hooks/useDiscover';
import { useDiscoverFilterDefaults } from '@app/hooks/useDiscoverFilterDefaults';
import { useRegisterHideWatchedRevalidation } from '@app/hooks/useRegisterHideWatchedRevalidation';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { CircleStackIcon, FunnelIcon } from '@heroicons/react/24/solid';
import type {
  MovieResult,
  PersonResult,
  TvResult,
} from '@server/models/Search';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover', {
  trending: 'Trending',
  timeWindowDay: 'Daily',
  timeWindowWeek: 'Weekly',
  activefilters:
    '{count, plural, one {# Active Filter} other {# Active Filters}}',
});

type MediaType = 'all' | 'movie' | 'tv';

type TimeWindow = 'day' | 'week';

const Trending = () => {
  const intl = useIntl();
  const router = useRouter();
  const { user } = useUser();
  const [currentMediaType, setCurrentMediaType] = useState<MediaType>('all');
  const [currentTimeWindow, setCurrentTimeWindow] = useState<TimeWindow>('day');
  const [showFilters, setShowFilters] = useState(false);
  const { data: discoverDefaults } = useDiscoverFilterDefaults();
  const preparedFilters = mergeFilterDefaults(
    prepareFilterValues(router.query),
    discoverDefaults,
    user?.id
  );
  const filterType: 'movie' | 'tv' = currentMediaType === 'tv' ? 'tv' : 'movie';
  const genreType: 'movie' | 'tv' | 'all' =
    currentMediaType === 'all' ? 'all' : filterType;

  const activeFilterCount =
    countActiveFilters(preparedFilters) +
    (preparedFilters.ignoreWatched === 'true' ||
    preparedFilters.ignoreWatched === 'false'
      ? 1
      : 0);
  const hideWatched = preparedFilters.ignoreWatched === 'true';

  const {
    isLoadingInitialData,
    isEmpty,
    isLoadingMore,
    isReachingEnd,
    titles,
    fetchMore,
    error,
    mutate,
  } = useDiscover<MovieResult | TvResult | PersonResult>(
    '/api/v1/discover/trending',
    {
      mediaType: currentMediaType,
      timeWindow: currentTimeWindow,
      ...preparedFilters,
      ...discoverDefaultsRequestExtras(user?.id),
    }
  );

  useRegisterHideWatchedRevalidation(mutate, hideWatched);

  if (error) {
    return <ErrorPage statusCode={500} />;
  }

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.trending)} />
      <div className="mb-5 mt-1 flex flex-col justify-between lg:flex-row lg:items-end">
        <Header>{intl.formatMessage(messages.trending)}</Header>
        <div className="mt-2 flex flex-grow flex-col sm:flex-row lg:flex-grow-0">
          <div className="mb-2 flex flex-grow sm:mb-0 sm:mr-2 lg:flex-grow-0">
            <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-sm text-gray-100">
              <CircleStackIcon className="h-6 w-6" />
            </span>
            <select
              id="mediaType"
              name="mediaType"
              onChange={(e) => setCurrentMediaType(e.target.value as MediaType)}
              value={currentMediaType}
              className="rounded-r-only"
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
            </select>
          </div>
          <div className="mb-2 flex flex-grow sm:mb-0 sm:mr-2 lg:flex-grow-0">
            <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-sm text-gray-100">
              <FunnelIcon className="h-6 w-6" />
            </span>
            <select
              id="timeWindow"
              name="timeWindow"
              onChange={(e) =>
                setCurrentTimeWindow(e.target.value as TimeWindow)
              }
              value={currentTimeWindow}
              className="rounded-r-only"
            >
              <option value="day">
                {intl.formatMessage(messages.timeWindowDay)}
              </option>
              <option value="week">
                {intl.formatMessage(messages.timeWindowWeek)}
              </option>
            </select>
          </div>
          <FilterSlideover
            type={filterType}
            genreType={genreType}
            capabilities={browseFilterCapabilities}
            showHideWatched
            currentFilters={preparedFilters}
            onClose={() => setShowFilters(false)}
            show={showFilters}
          />
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
      </div>
      <ListView
        items={titles}
        isEmpty={isEmpty}
        isLoading={
          isLoadingInitialData || (isLoadingMore && (titles?.length ?? 0) > 0)
        }
        isReachingEnd={isReachingEnd}
        onScrollBottom={fetchMore}
      />
    </>
  );
};

export default Trending;
