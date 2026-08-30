import TraktDiscoverPage from '@app/components/Discover/TraktDiscoverPage';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';
import { Link } from 'react-router';

const messages = defineMessages(
  'components.Discover.DiscoverTraktRecommendations',
  {
    title: 'Trakt Recommendations',
    linkAccount:
      'Link your Trakt account in Linked Accounts to browse personalized recommendations.',
    linkedAccounts: 'Linked Accounts',
  }
);

const DiscoverTraktRecommendations = () => {
  const intl = useIntl();

  return (
    <TraktDiscoverPage
      title={intl.formatMessage(messages.title)}
      endpoint="/api/v1/discover/trakt/recommendations"
      requiresLinkedAccount
      linkedAccountMessage={intl.formatMessage(messages.linkAccount)}
      linkedAccountsLabel={intl.formatMessage(messages.linkedAccounts)}
      showRecommendationFilters
      registerHideWatched
      subtext={
        <Link to="/discover/trakt/lists" className="hover:underline">
          Your Trakt Lists
        </Link>
      }
    />
  );
};

export default DiscoverTraktRecommendations;
