import TraktDiscoverPage from '@app/components/Discover/TraktDiscoverPage';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.DiscoverTraktChart', {
  trending: 'Trakt Trending',
  trendingDescription: 'What the Trakt community is watching right now.',
  popular: 'Trakt Popular',
  popularDescription:
    'The most-watched and best-rated titles on Trakt of all time.',
  anticipated: 'Trakt Anticipated',
  anticipatedDescription:
    'Upcoming titles that Trakt members are adding to the most lists.',
  linkAccount:
    'Trakt only shares its charts with linked accounts. Link your Trakt account in Linked Accounts to browse them.',
});

const descriptions = {
  trending: messages.trendingDescription,
  popular: messages.popularDescription,
  anticipated: messages.anticipatedDescription,
};

const DiscoverTraktChart = ({
  chart,
}: {
  chart: keyof typeof descriptions;
}) => {
  const intl = useIntl();

  return (
    <TraktDiscoverPage
      title={intl.formatMessage(messages[chart])}
      subtext={intl.formatMessage(descriptions[chart])}
      endpoint={`/api/v1/discover/trakt/${chart}`}
      requiresLinkedAccount
      linkedAccountMessage={intl.formatMessage(messages.linkAccount)}
    />
  );
};

export default DiscoverTraktChart;
