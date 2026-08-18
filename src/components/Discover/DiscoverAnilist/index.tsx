import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import useDiscover from '@app/hooks/useDiscover';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import Link from 'next/link';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.DiscoverAnilist', {
  trending: 'AniList Trending',
  season: 'AniList This Season',
  watching: 'AniList Watching',
  planning: 'AniList Planning',
  completed: 'AniList Completed',
  list: 'AniList List',
  linkAccount:
    'Link your AniList account in Linked Accounts to browse this list.',
  linkedAccounts: 'Linked Accounts',
});

type DiscoverAnilistPageProps = {
  kind: 'trending' | 'season' | 'watching' | 'planning' | 'completed' | 'list';
  endpoint: string;
  requiresLink?: boolean;
};

const DiscoverAnilistPage = ({
  kind,
  endpoint,
  requiresLink = false,
}: DiscoverAnilistPageProps) => {
  const intl = useIntl();
  const settings = useSettings();
  const { user } = useUser();
  const { data: anilistStatus } = useSWR<{
    connected: boolean;
    username: string | null;
  }>(
    settings.currentSettings.anilistConfigured && user && requiresLink
      ? `/api/v1/user/${user.id}/settings/linked-accounts/anilist`
      : null
  );

  const enabled =
    settings.currentSettings.anilistConfigured &&
    (!requiresLink || anilistStatus?.connected);
  const {
    isLoadingInitialData,
    isEmpty,
    isLoadingMore,
    isReachingEnd,
    titles,
    fetchMore,
    error,
  } = useDiscover<WatchlistItem>(enabled ? endpoint : '');

  if (!settings.currentSettings.anilistConfigured) {
    return <ErrorPage statusCode={404} />;
  }

  if (requiresLink && anilistStatus && !anilistStatus.connected) {
    return (
      <>
        <PageTitle title={intl.formatMessage(messages[kind])} />
        <div className="mb-5 mt-1">
          <Header>{intl.formatMessage(messages[kind])}</Header>
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
      <PageTitle title={intl.formatMessage(messages[kind])} />
      <div className="mb-5 mt-1">
        <Header>{intl.formatMessage(messages[kind])}</Header>
      </div>
      <ListView
        plexItems={titles}
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

export default DiscoverAnilistPage;
