import Button from '@app/components/Common/Button';
import Header from '@app/components/Common/Header';
import LinkButton from '@app/components/Common/LinkButton';
import PageTitle from '@app/components/Common/PageTitle';
import DiscoverProviderMessage from '@app/components/Discover/DiscoverProviderMessage';
import DiscoverProviderResults from '@app/components/Discover/DiscoverProviderResults';
import {
  ListFilterHeader,
  listFilterMessages,
} from '@app/components/Discover/ListFilterControls';
import MdblistListFilters from '@app/components/Discover/MdblistListFilters';
import {
  hasMdblistFilters,
  mdblistClearParams,
  prepareMdblistOptions,
} from '@app/components/Discover/MdblistListFilters/mdblistFilterOptions';
import { SliderSourceTitle } from '@app/components/Discover/SliderSourceMark';
import {
  discoverDefaultsRequestExtras,
  markDiscoverDefaultsCleared,
} from '@app/components/Discover/mergeFilterDefaults';
import useDiscover, { providerListFilters } from '@app/hooks/useDiscover';
import useRouteQuery from '@app/hooks/useRouteQuery';
import useSettings from '@app/hooks/useSettings';
import { useBatchUpdateQueryParams } from '@app/hooks/useUpdateQueryParams';
import { useUser } from '@app/hooks/useUser';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { XCircleIcon } from '@heroicons/react/24/outline';
import type { WatchlistItem } from '@shared/interfaces/api/discoverInterfaces';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.DiscoverMdblistList', {
  title: 'MDBList List',
  missingUrl: 'An MDBList list URL is required.',
  empty: 'This list has no titles to show. Try another list from Sources.',
  emptyFiltered: 'No titles in this list match your search and filters.',
  emptyRatedLocally:
    'None of the first 1,000 titles in this list match your rating filters.',
  sources: 'Browse list sources',
});

const DiscoverMdblistList = () => {
  const intl = useIntl();
  const settings = useSettings();
  const { user } = useUser();
  const query = useRouteQuery();
  const batchUpdateQueryParams = useBatchUpdateQueryParams({});
  const url = typeof query.url === 'string' ? query.url : '';

  const {
    isLoadingInitialData,
    isEmpty,
    isLoadingMore,
    isReachingEnd,
    titles,
    firstResultData,
    fetchMore,
    loadError,
    mutate,
  } = useDiscover<
    WatchlistItem,
    { title?: string; ratingsFilteredLocally?: boolean }
  >(
    url ? '/api/v1/discover/mdblist/list' : '',
    url
      ? {
          url,
          ...discoverDefaultsRequestExtras(user?.id),
          ...prepareMdblistOptions(query),
        }
      : undefined,
    providerListFilters
  );

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

  const pageTitle =
    firstResultData?.title || intl.formatMessage(messages.title);
  const filtered = hasMdblistFilters(query);

  return (
    <>
      <PageTitle title={pageTitle} />
      <ListFilterHeader
        title={
          <Header>
            <SliderSourceTitle source="mdblist">{pageTitle}</SliderSourceTitle>
          </Header>
        }
      >
        <MdblistListFilters />
      </ListFilterHeader>
      <DiscoverProviderResults
        source="MDBList"
        titles={titles}
        isEmpty={isEmpty}
        isLoadingInitialData={isLoadingInitialData}
        isLoadingMore={isLoadingMore}
        isReachingEnd={isReachingEnd}
        fetchMore={fetchMore}
        error={loadError}
        onRefresh={() => mutate?.()}
        mutate={mutate}
        emptyDescription={intl.formatMessage(
          firstResultData?.ratingsFilteredLocally
            ? messages.emptyRatedLocally
            : filtered
              ? messages.emptyFiltered
              : messages.empty
        )}
        emptyAction={
          filtered ? (
            <Button
              className="min-h-[44px]"
              onClick={() => {
                markDiscoverDefaultsCleared(user?.id);
                batchUpdateQueryParams(mdblistClearParams({ search: true }));
              }}
            >
              <XCircleIcon />
              <span>{intl.formatMessage(listFilterMessages.clearFilters)}</span>
            </Button>
          ) : (
            <LinkButton to="/discover/sources" className="min-h-[44px]">
              {intl.formatMessage(messages.sources)}
            </LinkButton>
          )
        }
      />
    </>
  );
};

export default DiscoverMdblistList;
