import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import DiscoverProviderMessage from '@app/components/Discover/DiscoverProviderMessage';
import { SliderSourceTitle } from '@app/components/Discover/SliderSourceMark';
import useDiscover, { providerListFilters } from '@app/hooks/useDiscover';
import useRouteQuery from '@app/hooks/useRouteQuery';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.DiscoverSimkl', {
  trending: 'Simkl Trending',
  watching: 'Simkl Watching',
  plantowatch: 'Simkl Plan to Watch',
  hold: 'Simkl On Hold',
  completed: 'Simkl Completed',
  dropped: 'Simkl Dropped',
  linkAccount:
    'Link your Simkl account in Linked Accounts to browse your library.',
});

type LibraryStatus =
  | 'watching'
  | 'plantowatch'
  | 'hold'
  | 'completed'
  | 'dropped';

const libraryStatuses = new Set<string>([
  'watching',
  'plantowatch',
  'hold',
  'completed',
  'dropped',
]);

const publicViews = {
  trending: {
    title: 'trending',
    endpoint: '/api/v1/discover/simkl/trending',
    options: undefined,
  },
} as const;

const DiscoverSimkl = () => {
  const intl = useIntl();
  const settings = useSettings();
  const { user } = useUser();
  const query = useRouteQuery();
  const viewKey = typeof query.view === 'string' ? query.view : undefined;
  const view = viewKey
    ? publicViews[viewKey as keyof typeof publicViews]
    : undefined;
  const status: LibraryStatus =
    typeof query.status === 'string' && libraryStatuses.has(query.status)
      ? (query.status as LibraryStatus)
      : 'plantowatch';
  const title = intl.formatMessage(messages[view ? view.title : status]);
  const { data: simklStatus } = useSWR<{ connected: boolean }>(
    settings.currentSettings.simklConfigured && !view && user
      ? `/api/v1/user/${user.id}/settings/linked-accounts/simkl`
      : null
  );
  const notLinked = !view && simklStatus?.connected === false;
  const {
    isLoadingInitialData,
    isEmpty,
    isLoadingMore,
    isReachingEnd,
    titles,
    fetchMore,
    error,
  } = useDiscover<WatchlistItem>(
    settings.currentSettings.simklConfigured && (!viewKey || view) && !notLinked
      ? view
        ? view.endpoint
        : '/api/v1/discover/simkl/library'
      : '',
    view ? view.options : { status },
    providerListFilters
  );
  if (viewKey && !view) return <ErrorPage statusCode={404} />;
  if (!settings.currentSettings.simklConfigured)
    return <ErrorPage statusCode={404} />;
  if (notLinked)
    return (
      <DiscoverProviderMessage
        title={title}
        source="simkl"
        message={intl.formatMessage(messages.linkAccount)}
        linkAccount
      />
    );
  if (error) return <ErrorPage statusCode={500} />;
  return (
    <>
      <PageTitle title={title} />
      <div className="mb-5 mt-1">
        <Header>
          <SliderSourceTitle source="simkl">{title}</SliderSourceTitle>
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

export default DiscoverSimkl;
