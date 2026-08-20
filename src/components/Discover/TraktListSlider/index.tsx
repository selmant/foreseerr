import TraktSlider from '@app/components/Discover/TraktSlider';
import { encodeURIExtraParams } from '@app/hooks/useDiscover';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.TraktListSlider', {
  empty: 'No items found for this Trakt list.',
});

interface TraktListSliderProps {
  title: string;
  url: string;
  sliderKey: string;
  hideTitle?: boolean;
  onNewTitles?: (titleCount: number) => void;
}

const TraktListSlider = ({
  title,
  url,
  sliderKey,
  hideTitle = false,
  onNewTitles,
}: TraktListSliderProps) => {
  const intl = useIntl();

  return (
    <TraktSlider
      title={title}
      href={`/discover/trakt/list?url=${encodeURIComponent(url)}`}
      endpoint={
        url
          ? `/api/v1/discover/trakt/list?url=${encodeURIExtraParams(url)}`
          : null
      }
      sliderKey={sliderKey}
      emptyMessage={intl.formatMessage(messages.empty)}
      hideTitle={hideTitle}
      onNewTitles={onNewTitles}
    />
  );
};

export default TraktListSlider;
