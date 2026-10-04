import Header from '@app/components/Common/Header';
import PageTitle from '@app/components/Common/PageTitle';
import DiscoverProviderMessage from '@app/components/Discover/DiscoverProviderMessage';
import DiscoverProviderResults from '@app/components/Discover/DiscoverProviderResults';
import { SliderSourceTitle } from '@app/components/Discover/SliderSourceMark';
import TraktDiscoverFilters from '@app/components/Discover/TraktDiscoverFilters';
import { prepareTraktDiscoverOptions } from '@app/components/Discover/TraktDiscoverFilters/traktDiscoverOptions';
import useDiscover, { providerListFilters } from '@app/hooks/useDiscover';
import { useRegisterHideWatchedRevalidation } from '@app/hooks/useRegisterHideWatchedRevalidation';
import useRouteQuery from '@app/hooks/useRouteQuery';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import type { ReactNode } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.TraktDiscoverPage', {
  empty:
    'Try another content type or adjust your filters. You can also choose another Trakt view above.',
});

interface TraktDiscoverPageProps {
  title: string;
  endpoint: string;
  queryExcludes?: string[];
  requiresLinkedAccount?: boolean;
  linkedAccountMessage?: string;
  missingMessage?: string;
  urlReady?: boolean;
  subtext?: ReactNode;
  showRecommendationFilters?: boolean;
  showHideWatchedFilter?: boolean;
  registerHideWatched?: boolean;
}

/** Shared loading, account gating, filters, and infinite-list layout for Trakt pages. */
const TraktDiscoverPage = ({
  title,
  endpoint,
  queryExcludes = [],
  requiresLinkedAccount = false,
  linkedAccountMessage,
  missingMessage,
  urlReady = true,
  subtext,
  showRecommendationFilters = false,
  showHideWatchedFilter,
  registerHideWatched = false,
}: TraktDiscoverPageProps) => {
  const intl = useIntl();
  const routeQuery = useRouteQuery();
  const settings = useSettings();
  const { user } = useUser();
  const {
    data: traktStatus,
    error: accountError,
    mutate: refreshAccount,
  } = useSWR<{
    connected: boolean;
    username: string | null;
  }>(
    requiresLinkedAccount && settings.currentSettings.traktConfigured && user
      ? `/api/v1/user/${user.id}/settings/linked-accounts/trakt`
      : null
  );

  const canLoad =
    settings.currentSettings.traktConfigured &&
    urlReady &&
    (!requiresLinkedAccount || traktStatus?.connected === true);
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
    canLoad ? endpoint : '',
    prepareTraktDiscoverOptions(routeQuery, queryExcludes, user?.id),
    providerListFilters
  );
  useRegisterHideWatchedRevalidation(mutate, registerHideWatched);

  if (!settings.currentSettings.traktConfigured) {
    return <ErrorPage statusCode={404} />;
  }

  if (missingMessage && !urlReady) {
    return (
      <DiscoverProviderMessage
        title={title}
        source="trakt"
        message={missingMessage}
      />
    );
  }

  if (
    requiresLinkedAccount &&
    traktStatus &&
    !traktStatus.connected &&
    linkedAccountMessage
  ) {
    return (
      <DiscoverProviderMessage
        title={title}
        source="trakt"
        message={linkedAccountMessage}
        linkAccount
      />
    );
  }

  const pageTitle = firstResultData?.title || title;

  return (
    <>
      <PageTitle title={pageTitle} />
      <div className="mb-5 mt-1 space-y-4 [&_h2]:whitespace-normal [&_h2]:break-words">
        <Header subtext={subtext}>
          <SliderSourceTitle source="trakt">{pageTitle}</SliderSourceTitle>
        </Header>
        <TraktDiscoverFilters
          showListSort={queryExcludes.includes('sort')}
          showHideWatchedFilter={showHideWatchedFilter}
          showRecommendationFilters={showRecommendationFilters}
        />
      </div>
      <DiscoverProviderResults
        source="Trakt"
        titles={titles}
        isEmpty={isEmpty}
        isLoadingInitialData={isLoadingInitialData && !accountError}
        isLoadingMore={isLoadingMore && !accountError}
        isReachingEnd={isReachingEnd}
        fetchMore={fetchMore}
        error={accountError || loadError}
        onRefresh={async () => {
          if (requiresLinkedAccount) await refreshAccount();
          await mutate?.();
        }}
        mutate={mutate}
        emptyDescription={intl.formatMessage(messages.empty)}
      />
    </>
  );
};

export default TraktDiscoverPage;
