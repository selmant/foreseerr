import Header from '@app/components/Common/Header';
import PageTitle from '@app/components/Common/PageTitle';
import AnilistListFilters from '@app/components/Discover/AnilistListFilters';
import { prepareAnilistOptions } from '@app/components/Discover/AnilistListFilters/anilistFilterOptions';
import DiscoverProviderMessage from '@app/components/Discover/DiscoverProviderMessage';
import DiscoverProviderResults from '@app/components/Discover/DiscoverProviderResults';
import { SliderSourceTitle } from '@app/components/Discover/SliderSourceMark';
import useDiscover, { providerListFilters } from '@app/hooks/useDiscover';
import useRouteQuery from '@app/hooks/useRouteQuery';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import type { WatchlistItem } from '@shared/interfaces/api/discoverInterfaces';
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
  paused: 'AniList On Hold',
  completed: 'AniList Completed',
  dropped: 'AniList Dropped',
  list: 'AniList List',
  linkAccount:
    'Link your AniList account in Linked Accounts to browse this list.',
  publicDescription:
    'Explore anime from AniList. Choose another view above to browse seasonal picks, popular titles, or the Top 100.',
  publicListDescription:
    'A public anime list from AniList. Choose a view above to explore more.',
  personalDescription:
    'Anime from your linked AniList library, grouped by your watch status.',
  empty:
    'Try another AniList view above. Personal lists follow the library in your linked AniList account.',
  emptyFiltered:
    'No titles in this list match your filters. Adjust or clear them to see more.',
});

/** Views that read a whole list, so anilist.co's list filters apply. */
const filterableKinds = new Set([
  'watching',
  'planning',
  'paused',
  'completed',
  'dropped',
  'list',
]);

type DiscoverAnilistPageProps = {
  kind:
    | 'trending'
    | 'season'
    | 'popular'
    | 'top'
    | 'nextSeason'
    | 'watching'
    | 'planning'
    | 'paused'
    | 'completed'
    | 'dropped'
    | 'list';
  endpoint: string;
  /** Request parameters besides the filters, such as a list's link. */
  params?: Record<string, string>;
  requiresLink?: boolean;
  /** Overrides the view name, such as with the name of an opened list. */
  title?: string;
};

const DiscoverAnilistPage = ({
  kind,
  endpoint,
  params,
  requiresLink = false,
  title: titleOverride,
}: DiscoverAnilistPageProps) => {
  const intl = useIntl();
  const settings = useSettings();
  const { user } = useUser();
  const query = useRouteQuery();
  const filterable = filterableKinds.has(kind);
  const filterOptions = filterable ? prepareAnilistOptions(query) : {};
  const filtered = Object.keys(filterOptions).length > 0;
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
    firstResultData,
    fetchMore,
    loadError,
    mutate,
  } = useDiscover<WatchlistItem, { title?: string }>(
    enabled ? endpoint : '',
    { ...params, ...filterOptions },
    providerListFilters
  );

  const title =
    titleOverride ||
    firstResultData?.title ||
    intl.formatMessage(messages[kind]);

  if (!settings.currentSettings.anilistConfigured) {
    return <ErrorPage statusCode={404} />;
  }

  if (requiresLink && anilistStatus && !anilistStatus.connected) {
    return (
      <DiscoverProviderMessage
        title={title}
        source="anilist"
        message={intl.formatMessage(messages.linkAccount)}
        linkAccount
      />
    );
  }

  return (
    <>
      <PageTitle title={title} />
      <div className="mb-5 mt-1 space-y-4 [&_h2]:whitespace-normal [&_h2]:break-words">
        <Header>
          <SliderSourceTitle source="anilist">{title}</SliderSourceTitle>
        </Header>
        <p className="max-w-2xl text-sm leading-6 text-gray-400">
          {intl.formatMessage(
            requiresLink
              ? messages.personalDescription
              : kind === 'list'
                ? messages.publicListDescription
                : messages.publicDescription
          )}
        </p>
        {filterable && <AnilistListFilters />}
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
        emptyDescription={intl.formatMessage(
          filtered ? messages.emptyFiltered : messages.empty
        )}
      />
    </>
  );
};

export default DiscoverAnilistPage;
