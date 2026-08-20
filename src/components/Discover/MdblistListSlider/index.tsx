import DiscoverProviderSlider from '@app/components/Discover/DiscoverProviderSlider';
import { encodeURIExtraParams } from '@app/hooks/useDiscover';
import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.MdblistListSlider', {
  empty: 'No items found for this MDBList list.',
});

interface MdblistListSliderProps {
  title: string;
  url: string;
  sliderKey: string;
  hideTitle?: boolean;
  onNewTitles?: (titleCount: number) => void;
}

const MdblistListSlider = ({
  title,
  url,
  sliderKey,
  hideTitle = false,
  onNewTitles,
}: MdblistListSliderProps) => {
  const intl = useIntl();
  const settings = useSettings();

  return (
    <DiscoverProviderSlider
      source="mdblist"
      configured={settings.currentSettings.mdblistConfigured}
      title={title}
      endpoint={
        url
          ? `/api/v1/discover/mdblist/list?url=${encodeURIExtraParams(url)}`
          : null
      }
      linkUrl={`/discover/mdblist/list?url=${encodeURIComponent(url)}`}
      sliderKey={sliderKey}
      emptyMessage={intl.formatMessage(messages.empty)}
      hideTitle={hideTitle}
      onNewTitles={onNewTitles}
    />
  );
};

export default MdblistListSlider;
