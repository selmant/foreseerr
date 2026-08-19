import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import { SliderSourceTitle } from '@app/components/Discover/SliderSourceMark';
import TraktDiscoverFilters from '@app/components/Discover/TraktDiscoverFilters';
import { prepareTraktDiscoverOptions } from '@app/components/Discover/TraktDiscoverFilters/traktDiscoverOptions';
import useDiscover from '@app/hooks/useDiscover';
import { useRegisterHideWatchedRevalidation } from '@app/hooks/useRegisterHideWatchedRevalidation';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.Discover.DiscoverTraktRecommendations',
  {
    title: 'Trakt Recommendations',
    linkAccount:
      'Link your Trakt account in Linked Accounts to browse personalized recommendations.',
    linkedAccounts: 'Linked Accounts',
  }
);

const DiscoverTraktRecommendations = () => {
  const intl = useIntl();
  const router = useRouter();
  const settings = useSettings();
  const { user } = useUser();
  const { data: traktStatus } = useSWR<{
    connected: boolean;
    username: string | null;
  }>(
    settings.currentSettings.traktConfigured && user
      ? `/api/v1/user/${user.id}/settings/linked-accounts/trakt`
      : null
  );

  const {
    isLoadingInitialData,
    isEmpty,
    isLoadingMore,
    isReachingEnd,
    titles,
    fetchMore,
    error,
    mutate,
  } = useDiscover<WatchlistItem>(
    traktStatus?.connected ? '/api/v1/discover/trakt/recommendations' : '',
    prepareTraktDiscoverOptions(router.query)
  );
  useRegisterHideWatchedRevalidation(mutate);

  if (!settings.currentSettings.traktConfigured) {
    return <ErrorPage statusCode={404} />;
  }

  if (traktStatus && !traktStatus.connected) {
    return (
      <>
        <PageTitle title={intl.formatMessage(messages.title)} />
        <div className="mb-5 mt-1">
          <Header>
            <SliderSourceTitle source="trakt">
              {intl.formatMessage(messages.title)}
            </SliderSourceTitle>
          </Header>
        </div>
        <div className="text-center text-gray-400">
          <p>{intl.formatMessage(messages.linkAccount)}</p>
          <Link
            href="/profile/settings/linked-accounts"
            className="mt-4 inline-block text-white underline"
          >
            {intl.formatMessage(messages.linkedAccounts)}
          </Link>
        </div>
      </>
    );
  }

  if (error) {
    return <ErrorPage statusCode={500} />;
  }

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.title)} />
      <div className="mb-5 mt-1 flex flex-col justify-between lg:flex-row lg:items-end">
        <Header
          subtext={
            <Link href="/discover/trakt/lists" className="hover:underline">
              Your Trakt Lists
            </Link>
          }
        >
          <SliderSourceTitle source="trakt">
            {intl.formatMessage(messages.title)}
          </SliderSourceTitle>
        </Header>
        <TraktDiscoverFilters showRecommendationFilters />
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

export default DiscoverTraktRecommendations;
