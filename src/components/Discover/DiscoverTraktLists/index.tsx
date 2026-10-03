import EmptyState from '@app/components/Common/EmptyState';
import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import DiscoverProviderMessage from '@app/components/Discover/DiscoverProviderMessage';
import { SliderSourceTitle } from '@app/components/Discover/SliderSourceMark';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { QueueListIcon } from '@heroicons/react/24/outline';
import { useIntl } from 'react-intl';
import { Link } from 'react-router';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.DiscoverTraktLists', {
  title: 'Your Trakt Lists',
  yourLists: 'Your Lists',
  linkAccount: 'Link your Trakt account to browse your personal lists.',
  items: '{count, plural, one {# item} other {# items}}',
  noLists: 'No Trakt lists found.',
  watchlist: 'Watchlist',
  likedLists: 'Liked Lists',
  liked: 'Liked',
});

interface TraktListResult {
  id: string;
  slug: string;
  name: string;
  itemCount: number;
  username?: string;
  isWatchlist?: boolean;
  isLiked?: boolean;
}

const DiscoverTraktLists = () => {
  const intl = useIntl();
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

  const { data, error } = useSWR<{ results: TraktListResult[] }>(
    traktStatus?.connected ? '/api/v1/discover/trakt/lists' : null
  );

  if (!settings.currentSettings.traktConfigured) {
    return <ErrorPage statusCode={404} />;
  }

  if (traktStatus && !traktStatus.connected) {
    return (
      <DiscoverProviderMessage
        title={intl.formatMessage(messages.title)}
        source="trakt"
        message={intl.formatMessage(messages.linkAccount)}
        linkAccount
      />
    );
  }

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (error) {
    return <ErrorPage statusCode={500} />;
  }

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
      {!data?.results.length && (
        <EmptyState
          icon={QueueListIcon}
          title={intl.formatMessage(messages.noLists)}
        />
      )}
      {[
        {
          title: intl.formatMessage(messages.yourLists),
          lists: (data?.results ?? []).filter((list) => !list.isLiked),
        },
        {
          title: intl.formatMessage(messages.likedLists),
          lists: (data?.results ?? []).filter((list) => list.isLiked),
        },
      ].map(
        (section) =>
          section.lists.length > 0 && (
            <section key={section.title} className="mb-8">
              <h2 className="mb-4 text-xl font-semibold text-white">
                {section.title}
              </h2>
              <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {section.lists.map((list) => {
                  const href =
                    list.id === 'watchlist' || list.isWatchlist
                      ? '/discover/trakt/watchlist'
                      : `/discover/trakt/list?url=${encodeURIComponent(
                          `${list.isLiked && list.username ? list.username : 'me'}/${list.slug || list.id}`
                        )}`;
                  return (
                    <li key={`${list.id}-${list.slug}`}>
                      <Link
                        to={href}
                        className="block rounded-xl bg-gray-800 p-5 shadow ring-1 ring-gray-700 transition duration-300 hover:shadow-lg hover:ring-gray-500"
                      >
                        <div className="text-lg font-semibold text-white">
                          {list.isWatchlist
                            ? intl.formatMessage(messages.watchlist)
                            : list.name}
                        </div>
                        {!list.isWatchlist && (
                          <div className="mt-1 text-sm text-gray-400">
                            {intl.formatMessage(messages.items, {
                              count: list.itemCount,
                            })}
                            {list.isLiked &&
                              ` · ${intl.formatMessage(messages.liked)}`}
                          </div>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          )
      )}
    </>
  );
};

export default DiscoverTraktLists;
