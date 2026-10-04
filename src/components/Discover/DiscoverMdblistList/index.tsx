import Header from '@app/components/Common/Header';
import LinkButton from '@app/components/Common/LinkButton';
import PageTitle from '@app/components/Common/PageTitle';
import DiscoverProviderMessage from '@app/components/Discover/DiscoverProviderMessage';
import DiscoverProviderResults from '@app/components/Discover/DiscoverProviderResults';
import { SliderSourceTitle } from '@app/components/Discover/SliderSourceMark';
import useDiscover, { providerListFilters } from '@app/hooks/useDiscover';
import useRouteQuery from '@app/hooks/useRouteQuery';
import useSettings from '@app/hooks/useSettings';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.DiscoverMdblistList', {
  title: 'MDBList List',
  missingUrl: 'An MDBList list URL is required.',
  empty: 'This list has no titles to show. Try another list from Sources.',
  sources: 'Browse list sources',
});

const DiscoverMdblistList = () => {
  const intl = useIntl();
  const settings = useSettings();
  const query = useRouteQuery();
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
  } = useDiscover<WatchlistItem, { title?: string }>(
    url ? '/api/v1/discover/mdblist/list' : '',
    url ? { url } : undefined,
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

  return (
    <>
      <PageTitle title={pageTitle} />
      <div className="mb-5 mt-1 [&_h2]:whitespace-normal [&_h2]:break-words">
        <Header>
          <SliderSourceTitle source="mdblist">{pageTitle}</SliderSourceTitle>
        </Header>
      </div>
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
        emptyDescription={intl.formatMessage(messages.empty)}
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
