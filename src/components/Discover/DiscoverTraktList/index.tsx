import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import TraktDiscoverFilters from '@app/components/Discover/TraktDiscoverFilters';
import { prepareTraktDiscoverOptions } from '@app/components/Discover/TraktDiscoverFilters/traktDiscoverOptions';
import useDiscover from '@app/hooks/useDiscover';
import useSettings from '@app/hooks/useSettings';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import { useRouter } from 'next/router';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.DiscoverTraktList', {
  title: 'Trakt List',
  missingUrl: 'A Trakt list URL is required.',
});

const DiscoverTraktList = () => {
  const intl = useIntl();
  const settings = useSettings();
  const router = useRouter();
  const url = typeof router.query.url === 'string' ? router.query.url : '';

  const {
    isLoadingInitialData,
    isEmpty,
    isLoadingMore,
    isReachingEnd,
    titles,
    fetchMore,
    error,
    mutate,
  } = useDiscover<WatchlistItem & { title?: string }>(
    url ? '/api/v1/discover/trakt/list' : '',
    prepareTraktDiscoverOptions(router.query, ['url', 'sort'])
  );

  if (!settings.currentSettings.traktConfigured) {
    return <ErrorPage statusCode={404} />;
  }

  if (!url) {
    return (
      <>
        <PageTitle title={intl.formatMessage(messages.title)} />
        <div className="mb-5 mt-1">
          <Header>{intl.formatMessage(messages.title)}</Header>
        </div>
        <p className="text-center text-gray-400">
          {intl.formatMessage(messages.missingUrl)}
        </p>
      </>
    );
  }

  if (error) {
    return <ErrorPage statusCode={500} />;
  }

  const pageTitle = intl.formatMessage(messages.title);

  return (
    <>
      <PageTitle title={pageTitle} />
      <div className="mb-5 mt-1 flex flex-col justify-between lg:flex-row lg:items-end">
        <Header>{pageTitle}</Header>
        <TraktDiscoverFilters />
      </div>
      <ListView
        plexItems={titles}
        isEmpty={isEmpty}
        isLoading={
          isLoadingInitialData || (isLoadingMore && (titles?.length ?? 0) > 0)
        }
        isReachingEnd={isReachingEnd}
        onScrollBottom={fetchMore}
        mutateParent={mutate}
      />
    </>
  );
};

export default DiscoverTraktList;
