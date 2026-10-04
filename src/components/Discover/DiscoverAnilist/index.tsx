import Header from '@app/components/Common/Header';
import PageTitle from '@app/components/Common/PageTitle';
import DiscoverProviderMessage from '@app/components/Discover/DiscoverProviderMessage';
import DiscoverProviderResults from '@app/components/Discover/DiscoverProviderResults';
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
  publicDescription:
    'Explore anime from AniList. Choose another view above to browse seasonal picks, popular titles, or the Top 100.',
  personalDescription:
    'Anime from your linked AniList library, grouped by your watch status.',
  empty:
    'Try another AniList view above. Personal lists follow the library in your linked AniList account.',
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
  const {
    data: anilistStatus,
    error: accountError,
    mutate: refreshAccount,
  } = useSWR<{
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
    loadError,
    mutate,
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

  return (
    <>
      <PageTitle title={intl.formatMessage(messages[kind])} />
      <div className="mb-5 mt-1 space-y-4 [&_h2]:whitespace-normal [&_h2]:break-words">
        <Header>
          <SliderSourceTitle source="anilist">
            {intl.formatMessage(messages[kind])}
          </SliderSourceTitle>
        </Header>
        <p className="max-w-2xl text-sm leading-6 text-gray-400">
          {intl.formatMessage(
            requiresLink
              ? messages.personalDescription
              : messages.publicDescription
          )}
        </p>
      </div>
      <DiscoverProviderResults
        source="AniList"
        titles={titles}
        isEmpty={isEmpty}
        isLoadingInitialData={isLoadingInitialData && !accountError}
        isLoadingMore={isLoadingMore && !accountError}
        isReachingEnd={isReachingEnd}
        fetchMore={fetchMore}
        error={accountError || loadError}
        onRefresh={async () => {
          if (requiresLink) await refreshAccount();
          await mutate?.();
        }}
        mutate={mutate}
        emptyDescription={intl.formatMessage(messages.empty)}
      />
    </>
  );
};

export default DiscoverAnilistPage;
