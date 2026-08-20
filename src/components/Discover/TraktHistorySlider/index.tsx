import TraktSlider from '@app/components/Discover/TraktSlider';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.TraktHistorySlider', {
  trakthistory: 'Trakt History',
  emptyhistory:
    'Titles you mark watched on Trakt will appear here after you link your account.',
});

interface TraktHistorySliderProps {
  title?: string;
  sliderKey?: string;
  hideTitle?: boolean;
  onNewTitles?: (titleCount: number) => void;
}

const TraktHistorySlider = ({
  title,
  sliderKey = 'trakt-history',
  hideTitle = false,
  onNewTitles,
}: TraktHistorySliderProps = {}) => {
  const intl = useIntl();
  const displayTitle = title ?? intl.formatMessage(messages.trakthistory);

  return (
    <TraktSlider
      title={displayTitle}
      href="/discover/trakt/history"
      endpoint="/api/v1/discover/trakt/history"
      sliderKey={sliderKey}
      emptyMessage={intl.formatMessage(messages.emptyhistory)}
      requiresLinkedAccount
      hideTitle={hideTitle}
      onNewTitles={onNewTitles}
    />
  );
};

export default TraktHistorySlider;
