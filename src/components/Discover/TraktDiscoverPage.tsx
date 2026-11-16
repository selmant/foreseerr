import Button from '@app/components/Common/Button';
import Header from '@app/components/Common/Header';
import PageTitle from '@app/components/Common/PageTitle';
import DiscoverProviderMessage from '@app/components/Discover/DiscoverProviderMessage';
import DiscoverProviderResults from '@app/components/Discover/DiscoverProviderResults';
import {
  ListFilterHeader,
  listFilterMessages,
} from '@app/components/Discover/ListFilterControls';
import { SliderSourceTitle } from '@app/components/Discover/SliderSourceMark';
import TraktDiscoverFilters from '@app/components/Discover/TraktDiscoverFilters';
import { prepareTraktDiscoverOptions } from '@app/components/Discover/TraktDiscoverFilters/traktDiscoverOptions';
import {
  countTraktFilters,
  traktClearParams,
} from '@app/components/Discover/TraktDiscoverFilters/traktListOptions';
import { prepareFilterValues } from '@app/components/Discover/constants';
import {
  markDiscoverDefaultsCleared,
  mergeFilterDefaults,
} from '@app/components/Discover/mergeFilterDefaults';
import useDiscover, { providerListFilters } from '@app/hooks/useDiscover';
import { useDiscoverFilterDefaults } from '@app/hooks/useDiscoverFilterDefaults';
import { useRegisterHideWatchedRevalidation } from '@app/hooks/useRegisterHideWatchedRevalidation';
import useRouteQuery from '@app/hooks/useRouteQuery';
import useSettings from '@app/hooks/useSettings';
import { useBatchUpdateQueryParams } from '@app/hooks/useUpdateQueryParams';
import { useUser } from '@app/hooks/useUser';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { XCircleIcon } from '@heroicons/react/24/outline';
import type { WatchlistItem } from '@shared/interfaces/api/discoverInterfaces';
import type { ReactNode } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.TraktDiscoverPage', {
  empty: 'Try another content type or choose another Trakt view above.',
  emptyFiltered: 'No titles here match your filters.',
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
  const batchUpdateQueryParams = useBatchUpdateQueryParams({});
  const { data: discoverDefaults } = useDiscoverFilterDefaults();
  const preparedFilters = mergeFilterDefaults(
    prepareFilterValues(routeQuery),
    discoverDefaults,
    user?.id
  );
  const filtered =
    countTraktFilters(preparedFilters, {
      showHideWatched: showHideWatchedFilter ?? true,
      showRecommendationFilters,
    }) > 0;
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
      <ListFilterHeader
        title={
          <Header subtext={subtext}>
            <SliderSourceTitle source="trakt">{pageTitle}</SliderSourceTitle>
          </Header>
        }
      >
        <TraktDiscoverFilters
          showListSort={queryExcludes.includes('sort')}
          showHideWatchedFilter={showHideWatchedFilter}
          showRecommendationFilters={showRecommendationFilters}
        />
      </ListFilterHeader>
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
        emptyDescription={intl.formatMessage(
          filtered ? messages.emptyFiltered : messages.empty
        )}
        emptyAction={
          filtered ? (
            <Button
              className="min-h-[44px]"
              onClick={() => {
                markDiscoverDefaultsCleared(user?.id);
                batchUpdateQueryParams(traktClearParams(preparedFilters));
              }}
            >
              <XCircleIcon />
              <span>{intl.formatMessage(listFilterMessages.clearFilters)}</span>
            </Button>
          ) : undefined
        }
      />
    </>
  );
};

export default TraktDiscoverPage;
