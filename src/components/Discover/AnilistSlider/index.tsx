import DiscoverProviderSlider from '@app/components/Discover/DiscoverProviderSlider';
import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.AnilistSlider', {
  empty: 'No anime found.',
});

interface AnilistSliderProps {
  title: string;
  endpoint: string;
  linkUrl: string;
  sliderKey: string;
  hideTitle?: boolean;
  onNewTitles?: (titleCount: number) => void;
}

const AnilistSlider = ({
  title,
  endpoint,
  linkUrl,
  sliderKey,
  hideTitle = false,
  onNewTitles,
}: AnilistSliderProps) => {
  const intl = useIntl();
  const settings = useSettings();

  return (
    <DiscoverProviderSlider
      source="anilist"
      configured={settings.currentSettings.anilistConfigured}
      title={title}
      endpoint={endpoint}
      linkUrl={linkUrl}
      sliderKey={sliderKey}
      emptyMessage={intl.formatMessage(messages.empty)}
      hideTitle={hideTitle}
      onNewTitles={onNewTitles}
    />
  );
};

export default AnilistSlider;
