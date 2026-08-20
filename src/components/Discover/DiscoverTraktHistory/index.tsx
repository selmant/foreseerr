import TraktDiscoverPage from '@app/components/Discover/TraktDiscoverPage';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.DiscoverTraktHistory', {
  title: 'Trakt History',
  linkAccount:
    'Link your Trakt account in Linked Accounts to browse your watch history.',
  linkedAccounts: 'Linked Accounts',
});

const DiscoverTraktHistory = () => {
  const intl = useIntl();

  return (
    <TraktDiscoverPage
      title={intl.formatMessage(messages.title)}
      endpoint="/api/v1/discover/trakt/history"
      requiresLinkedAccount
      linkedAccountMessage={intl.formatMessage(messages.linkAccount)}
      linkedAccountsLabel={intl.formatMessage(messages.linkedAccounts)}
      showHideWatchedFilter={false}
    />
  );
};

export default DiscoverTraktHistory;
