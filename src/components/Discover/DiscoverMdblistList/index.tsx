import useDiscover, { providerListFilters } from '@app/hooks/useDiscover';
import type { WatchlistItem } from '@shared/interfaces/api/discoverInterfaces';
import { prepareFilterValues } from '@app/components/Discover/constants';
import Header from '@app/components/Common/Header';
import LinkButton from '@app/components/Common/LinkButton';
import PageTitle from '@app/components/Common/PageTitle';
import DiscoverProviderMessage from '@app/components/Discover/DiscoverProviderMessage';
import DiscoverProviderResults from '@app/components/Discover/DiscoverProviderResults';
import { SliderSourceTitle } from '@app/components/Discover/SliderSourceMark';
import MdblistBrowseControls from '@app/components/Discover/MdblistBrowseControls';
import useMdblistBrowse from '@app/hooks/useMdblistBrowse';
import { mdblistSort, viewMdblistItems } from '@app/utils/mdblistBrowse';
import useRouteQuery from '@app/hooks/useRouteQuery';
import useSettings from '@app/hooks/useSettings';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.DiscoverMdblistList', {
  title: 'MDBList List',
  missingUrl: 'An MDBList list URL is required.',
  empty: 'This list has no titles to show. Try another list from Sources.',
  sources: 'Browse list sources',
  filteredEmpty:
    'No titles match these dates. Clear the filters to see the full list.',
});

const DiscoverMdblistList = () => {
  const intl = useIntl();
  const settings = useSettings();
  const query = useRouteQuery();
  const url = typeof query.url === 'string' ? query.url : '';

  const filters = prepareFilterValues(query);
  filters.sortBy = mdblistSort(filters.sortBy);
  const completeList =
    filters.sortBy !== 'source' ||
    Boolean(
      filters.primaryReleaseDateGte ||
      filters.primaryReleaseDateLte ||
      filters.firstAirDateGte ||
      filters.firstAirDateLte
    );
  const full = useMdblistBrowse(completeList ? url : '');
  const paged = useDiscover<WatchlistItem, { title?: string }>(
    !completeList && url ? '/api/v1/discover/mdblist/list' : '',
    { url },
    providerListFilters
  );
  const data = completeList ? full.data : paged.firstResultData;
  const loadError = completeList ? full.error : paged.loadError;
  const isLoadingInitialData = completeList
    ? full.isLoading
    : paged.isLoadingInitialData;
  const mutate = completeList ? full.mutate : paged.mutate;
  const visible = settings.currentSettings.hideRequested
    ? data?.results.filter((item) => !item.hasActiveRequest)
    : data?.results;
  const titles = completeList
    ? viewMdblistItems(visible ?? [], filters)
    : paged.titles;

  if (!settings.currentSettings.mdblistConfigured) {
    return <ErrorPage statusCode={404} />;
  }

  if (!url) {
    return (
      <DiscoverProviderMessage
        title={intl.formatMessage(messages.title)}
        source="mdblist"
        message={intl.formatMessage(messages.missingUrl)}
      />
    );
  }

  const pageTitle = data?.title || intl.formatMessage(messages.title);

  return (
    <>
      <PageTitle title={pageTitle} />
      <div className="mb-4 flex flex-col justify-between lg:flex-row lg:items-end [&_h2]:whitespace-normal [&_h2]:break-words">
        <Header>
          <SliderSourceTitle source="mdblist">{pageTitle}</SliderSourceTitle>
        </Header>
        <MdblistBrowseControls currentFilters={filters} type="all" />
      </div>
      <DiscoverProviderResults
        source="MDBList"
        titles={titles}
        isEmpty={!isLoadingInitialData && titles.length === 0}
        isLoadingInitialData={isLoadingInitialData}
        isLoadingMore={!completeList && paged.isLoadingMore}
        isReachingEnd={completeList || paged.isReachingEnd}
        fetchMore={completeList ? () => undefined : paged.fetchMore}
        error={loadError}
        onRefresh={() => mutate?.()}
        mutate={() => {
          void mutate?.();
        }}
        emptyDescription={intl.formatMessage(
          filters.primaryReleaseDateGte ||
            filters.primaryReleaseDateLte ||
            filters.firstAirDateGte ||
            filters.firstAirDateLte
            ? messages.filteredEmpty
            : messages.empty
        )}
        emptyAction={
          <LinkButton to="/discover/sources" className="min-h-[44px]">
            {intl.formatMessage(messages.sources)}
          </LinkButton>
        }
      />
    </>
  );
};

export default DiscoverMdblistList;
