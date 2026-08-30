import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import useDiscover from '@app/hooks/useDiscover';
import useRouteQuery from '@app/hooks/useRouteQuery';
import { useUser } from '@app/hooks/useUser';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import { useIntl } from 'react-intl';
import { Link, useLocation } from 'react-router';

const messages = defineMessages('components.Discover.DiscoverWatchlist', {
  discoverwatchlist: 'Your Watchlist',
  watchlist: 'Plex Watchlist',
});

const DiscoverWatchlist = () => {
  const intl = useIntl();
  const location = useLocation();
  const routeQuery = useRouteQuery();
  const { user } = useUser({
    id: Number(routeQuery.userId),
  });
  const { user: currentUser } = useUser();

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
    `/api/v1/${
      location.pathname.startsWith('/profile')
        ? `user/${currentUser?.id}`
        : routeQuery.userId
          ? `user/${routeQuery.userId}`
          : 'discover'
    }/watchlist`
  );

  if (error) {
    return <ErrorPage statusCode={500} />;
  }

  const title = intl.formatMessage(
    routeQuery.userId ? messages.watchlist : messages.discoverwatchlist
  );

  return (
    <>
      <PageTitle title={[title, routeQuery.userId ? user?.displayName : '']} />
      <div className="mb-5 mt-1">
        <Header
          subtext={
            routeQuery.userId ? (
              <Link to={`/users/${user?.id}`} className="hover:underline">
                {user?.displayName}
              </Link>
            ) : (
              ''
            )
          }
        >
          {title}
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
        mutateParent={mutate}
      />
    </>
  );
};

export default DiscoverWatchlist;
