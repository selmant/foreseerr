import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import Header from '@app/components/Common/Header';
import LinkButton from '@app/components/Common/LinkButton';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import useDiscover, { providerListFilters } from '@app/hooks/useDiscover';
import useRouteQuery from '@app/hooks/useRouteQuery';
import { UserType, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { ArrowPathIcon, BookmarkIcon } from '@heroicons/react/24/outline';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import { useIntl } from 'react-intl';
import { Link, useLocation } from 'react-router';

const messages = defineMessages('components.Discover.DiscoverWatchlist', {
  discoverwatchlist: 'Your Watchlist',
  watchlist: 'Plex Watchlist',
  ownerWatchlist: "{username}'s Watchlist",
  localDescription:
    'Keep movies and series you want to come back to. Use Watchlist on a title’s page to save it here.',
  otherDescription: 'Movies and series saved by this user.',
  plexDescription:
    'Movies and series saved to this account’s Plex Watchlist appear here.',
  empty: 'Your watchlist is ready for its first title',
  emptyOther: 'This watchlist is empty',
  emptyHint:
    'Explore Discover, open a title, and choose Watchlist to save it for later.',
  emptyPlexHint:
    'Add a movie or series to your Plex Watchlist, then refresh this page.',
  browse: 'Explore Discover',
  sources: 'Browse list sources',
  refresh: 'Refresh watchlist',
  retry: 'Try again',
  loadError: 'Could not load this watchlist. Try again.',
  loadMore: 'Load more titles',
  loadingMore: 'Loading titles…',
  count: '{count} of {total} titles',
  loaded: '{count, plural, one {# title} other {# titles}}',
});

const DiscoverWatchlist = () => {
  const intl = useIntl();
  const location = useLocation();
  const routeQuery = useRouteQuery();
  const { user } = useUser({
    id: Number(routeQuery.userId),
  });
  const { user: currentUser } = useUser();
  const isOtherUser = Boolean(
    routeQuery.userId && Number(routeQuery.userId) !== currentUser?.id
  );
  const isPlex =
    location.pathname.startsWith('/discover') ||
    user?.userType === UserType.PLEX;

  const {
    isLoadingInitialData,
    isEmpty,
    isLoadingMore,
    isReachingEnd,
    titles,
    fetchMore,
    loadError: error,
    mutate,
    firstResultData,
  } = useDiscover<WatchlistItem>(
    location.pathname.startsWith('/profile') && !currentUser
      ? ''
      : `/api/v1/${
          location.pathname.startsWith('/profile')
            ? `user/${currentUser?.id}`
            : routeQuery.userId
              ? `user/${routeQuery.userId}`
              : 'discover'
        }/watchlist`,
    undefined,
    { ...providerListFilters, hideRequested: false }
  );

  const title = intl.formatMessage(
    routeQuery.userId
      ? isPlex
        ? messages.watchlist
        : messages.ownerWatchlist
      : messages.discoverwatchlist,
    { username: user?.displayName ?? '' }
  );

  return (
    <>
      <PageTitle title={[title, routeQuery.userId ? user?.displayName : '']} />
      <div className="mb-5 mt-1 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4 [&>div]:mt-0">
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
          <Button
            type="button"
            buttonType="ghost"
            className="min-h-[44px]"
            disabled={isLoadingInitialData || isLoadingMore}
            onClick={() => mutate?.()}
          >
            <ArrowPathIcon />
            <span>{intl.formatMessage(messages.refresh)}</span>
          </Button>
        </div>
        <p className="max-w-2xl text-sm leading-6 text-gray-400">
          {intl.formatMessage(
            isPlex
              ? messages.plexDescription
              : isOtherUser
                ? messages.otherDescription
                : messages.localDescription
          )}
        </p>
        {!isOtherUser && (
          <div className="flex flex-wrap gap-2">
            <LinkButton to="/" className="min-h-[44px]">
              {intl.formatMessage(messages.browse)}
            </LinkButton>
            <LinkButton
              to="/discover/sources"
              buttonType="ghost"
              className="min-h-[44px]"
            >
              {intl.formatMessage(messages.sources)}
            </LinkButton>
          </div>
        )}
        {!isLoadingInitialData && !error && !isEmpty && (
          <p role="status" className="text-sm text-gray-400">
            {intl.formatMessage(
              firstResultData?.totalResults != null
                ? messages.count
                : messages.loaded,
              { count: titles.length, total: firstResultData?.totalResults }
            )}
          </p>
        )}
      </div>
      {error && (
        <div className="mb-5 space-y-3">
          <Alert type="error" title={intl.formatMessage(messages.loadError)} />
          <Button
            type="button"
            className="min-h-[44px]"
            onClick={() => mutate?.()}
          >
            {intl.formatMessage(messages.retry)}
          </Button>
        </div>
      )}
      {(!error || titles.length > 0) && (
        <>
          <ListView
            plexItems={titles}
            isEmpty={isEmpty}
            isLoading={
              isLoadingInitialData ||
              (isLoadingMore && (titles?.length ?? 0) > 0)
            }
            isReachingEnd={isReachingEnd}
            onScrollBottom={fetchMore}
            mutateParent={mutate}
            emptyContent={
              <div className="mt-8 rounded-xl border border-gray-700 bg-gray-800/50 px-5 py-10 text-center">
                <BookmarkIcon
                  aria-hidden="true"
                  className="mx-auto mb-4 h-10 w-10 text-indigo-400"
                />
                <h2 className="text-lg font-semibold text-white">
                  {intl.formatMessage(
                    isOtherUser ? messages.emptyOther : messages.empty
                  )}
                </h2>
                <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-gray-400">
                  {!isOtherUser &&
                    intl.formatMessage(
                      isPlex ? messages.emptyPlexHint : messages.emptyHint
                    )}
                </p>
                {!isOtherUser && !isPlex && (
                  <LinkButton to="/" className="mt-5 min-h-[44px]">
                    {intl.formatMessage(messages.browse)}
                  </LinkButton>
                )}
              </div>
            }
          />
          {!isEmpty && !isReachingEnd && (
            <div className="my-6 flex justify-center">
              <Button
                type="button"
                buttonType="ghost"
                className="min-h-[44px]"
                disabled={isLoadingMore || Boolean(error)}
                onClick={fetchMore}
              >
                {intl.formatMessage(
                  isLoadingMore ? messages.loadingMore : messages.loadMore
                )}
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
};

export default DiscoverWatchlist;
