import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import DiscoverProviderMessage from '@app/components/Discover/DiscoverProviderMessage';
import { SliderSourceTitle } from '@app/components/Discover/SliderSourceMark';
import useDiscover, { providerListFilters } from '@app/hooks/useDiscover';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.DiscoverAnilist', {
  trending: 'AniList Trending',
  season: 'AniList This Season',
  popular: 'AniList Popular',
  top: 'AniList Top 100',
  nextSeason: 'AniList Next Season',
  watching: 'AniList Watching',
  planning: 'AniList Planning',
  completed: 'AniList Completed',
  list: 'AniList List',
  linkAccount:
    'Link your AniList account in Linked Accounts to browse this list.',
});

type DiscoverAnilistPageProps = {
  kind:
    | 'trending'
    | 'season'
    | 'popular'
    | 'top'
    | 'nextSeason'
    | 'watching'
    | 'planning'
    | 'completed'
    | 'list';
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
  } = useDiscover<WatchlistItem>(
    enabled ? endpoint : '',
    undefined,
    providerListFilters
  );

  if (!settings.currentSettings.anilistConfigured) {
    return <ErrorPage statusCode={404} />;
  }

  if (requiresLink && anilistStatus && !anilistStatus.connected) {
    return (
      <DiscoverProviderMessage
        title={intl.formatMessage(messages[kind])}
        source="anilist"
        message={intl.formatMessage(messages.linkAccount)}
        linkAccount
      />
    );
  }

  if (error) {
    return <ErrorPage statusCode={500} />;
  }

  return (
    <>
      <PageTitle title={intl.formatMessage(messages[kind])} />
      <div className="mb-5 mt-1">
        <Header>
          <SliderSourceTitle source="anilist">
            {intl.formatMessage(messages[kind])}
          </SliderSourceTitle>
        </Header>
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
