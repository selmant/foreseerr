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
    yourLists: 'Browse your Trakt lists',
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
      showRecommendationFilters
      registerHideWatched
      subtext={
        <Link
          to="/discover/trakt/lists"
          className="text-indigo-400 transition hover:text-indigo-300 hover:underline"
        >
          {intl.formatMessage(messages.yourLists)}
        </Link>
      }
    />
  );
};

export default DiscoverTraktRecommendations;
