import TraktDiscoverPage from '@app/components/Discover/TraktDiscoverPage';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.DiscoverTraktWatchlist', {
  title: 'Trakt Watchlist',
  linkAccount:
    'Link your Trakt account in Linked Accounts to browse your watchlist.',
  linkedAccounts: 'Linked Accounts',
});

const DiscoverTraktWatchlist = () => {
  const intl = useIntl();

  return (
    <TraktDiscoverPage
      title={intl.formatMessage(messages.title)}
      endpoint="/api/v1/discover/trakt/watchlist"
      requiresLinkedAccount
      linkedAccountMessage={intl.formatMessage(messages.linkAccount)}
      linkedAccountsLabel={intl.formatMessage(messages.linkedAccounts)}
      registerHideWatched
    />
  );
};

export default DiscoverTraktWatchlist;
