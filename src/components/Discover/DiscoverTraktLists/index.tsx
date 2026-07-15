import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import Link from 'next/link';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.DiscoverTraktLists', {
  title: 'Your Trakt Lists',
  linkAccount: 'Link your Trakt account to browse your personal lists.',
  items: '{count} items',
  watchlist: 'Watchlist',
});

interface TraktListResult {
  id: string;
  slug: string;
  name: string;
  itemCount: number;
  isWatchlist?: boolean;
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
      <>
        <PageTitle title={intl.formatMessage(messages.title)} />
        <div className="mb-5 mt-1">
          <Header>{intl.formatMessage(messages.title)}</Header>
        </div>
        <div className="text-center text-gray-400">
          <p>{intl.formatMessage(messages.linkAccount)}</p>
          <Link
            href="/profile/settings/linked-accounts"
            className="mt-4 inline-block text-white underline"
          >
            Linked Accounts
          </Link>
        </div>
      </>
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
        <Header>{intl.formatMessage(messages.title)}</Header>
      </div>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {(data?.results ?? []).map((list) => {
          const href =
            list.id === 'watchlist' || list.isWatchlist
              ? '/discover/trakt/watchlist'
              : `/discover/trakt/list?url=${encodeURIComponent(
                  `me/${list.slug || list.id}`
                )}`;
          return (
            <li key={`${list.id}-${list.slug}`}>
              <Link
                href={href}
                className="block rounded-lg bg-gray-800/50 p-5 shadow ring-1 ring-gray-700 transition hover:bg-gray-800"
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
                  </div>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );
};

export default DiscoverTraktLists;
