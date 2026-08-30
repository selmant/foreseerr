import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import { SliderSourceTitle } from '@app/components/Discover/SliderSourceMark';
import TraktDiscoverFilters from '@app/components/Discover/TraktDiscoverFilters';
import { prepareTraktDiscoverOptions } from '@app/components/Discover/TraktDiscoverFilters/traktDiscoverOptions';
import useDiscover from '@app/hooks/useDiscover';
import { useRegisterHideWatchedRevalidation } from '@app/hooks/useRegisterHideWatchedRevalidation';
import useRouteQuery from '@app/hooks/useRouteQuery';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import ErrorPage from '@app/pages/_error';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import useSWR from 'swr';

interface TraktDiscoverPageProps {
  title: string;
  endpoint: string;
  queryExcludes?: string[];
  requiresLinkedAccount?: boolean;
  linkedAccountMessage?: string;
  linkedAccountsLabel?: string;
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
  linkedAccountsLabel = 'Linked Accounts',
  missingMessage,
  urlReady = true,
  subtext,
  showRecommendationFilters = false,
  showHideWatchedFilter,
  registerHideWatched = false,
}: TraktDiscoverPageProps) => {
  const routeQuery = useRouteQuery();
  const settings = useSettings();
  const { user } = useUser();
  const { data: traktStatus } = useSWR<{
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
    error,
    mutate,
  } = useDiscover<WatchlistItem, { title?: string }>(
    canLoad ? endpoint : '',
    prepareTraktDiscoverOptions(routeQuery, queryExcludes, user?.id)
  );
  useRegisterHideWatchedRevalidation(mutate, registerHideWatched);

  if (!settings.currentSettings.traktConfigured) {
    return <ErrorPage statusCode={404} />;
  }

  if (missingMessage && !urlReady) {
    return <TraktDiscoverMessage title={title} message={missingMessage} />;
  }

  if (
    requiresLinkedAccount &&
    traktStatus &&
    !traktStatus.connected &&
    linkedAccountMessage
  ) {
    return (
      <TraktDiscoverMessage
        title={title}
        message={linkedAccountMessage}
        linkAccount
        linkedAccountsLabel={linkedAccountsLabel}
      />
    );
  }

  if (error) {
    return <ErrorPage statusCode={500} />;
  }

  const pageTitle = firstResultData?.title || title;

  return (
    <>
      <PageTitle title={pageTitle} />
      <div className="mb-5 mt-1 flex flex-col justify-between lg:flex-row lg:items-end">
        <Header subtext={subtext}>
          <SliderSourceTitle source="trakt">{pageTitle}</SliderSourceTitle>
        </Header>
        <TraktDiscoverFilters
          showHideWatchedFilter={showHideWatchedFilter}
          showRecommendationFilters={showRecommendationFilters}
        />
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

const TraktDiscoverMessage = ({
  title,
  message,
  linkAccount = false,
  linkedAccountsLabel,
}: {
  title: string;
  message: string;
  linkAccount?: boolean;
  linkedAccountsLabel?: string;
}) => (
  <>
    <PageTitle title={title} />
    <div className="mb-5 mt-1">
      <Header>
        <SliderSourceTitle source="trakt">{title}</SliderSourceTitle>
      </Header>
    </div>
    <div className="text-center text-gray-400">
      <p>{message}</p>
      {linkAccount && (
        <Link
          to="/profile/settings/linked-accounts"
          className="mt-4 inline-block text-white underline"
        >
          {linkedAccountsLabel}
        </Link>
      )}
    </div>
  </>
);

export default TraktDiscoverPage;
