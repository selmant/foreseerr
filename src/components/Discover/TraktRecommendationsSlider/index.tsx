import TraktSlider from '@app/components/Discover/TraktSlider';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages(
  'components.Discover.TraktRecommendationsSlider',
  {
    traktrecommendations: 'Trakt Recommendations',
    empty:
      'Personalized Trakt recommendations will appear here after you link your account.',
  }
);

const TraktRecommendationsSlider = () => {
  const intl = useIntl();

  return (
    <TraktSlider
      title={intl.formatMessage(messages.traktrecommendations)}
      href="/discover/trakt/recommendations"
      endpoint="/api/v1/discover/trakt/recommendations"
      sliderKey="trakt-recommendations"
      emptyMessage={intl.formatMessage(messages.empty)}
      requiresLinkedAccount
    />
  );
};

export default TraktRecommendationsSlider;
