import DiscoverProviderSlider from '@app/components/Discover/DiscoverProviderSlider';
import useSettings from '@app/hooks/useSettings';

interface SimklSliderProps {
  title: string;
  endpoint: string;
  linkUrl: string;
  sliderKey: string;
  requiresLink?: boolean;
}

const SimklSlider = ({ requiresLink = false, ...props }: SimklSliderProps) => {
  const settings = useSettings();
  // Linked state is verified by the endpoint; configuration still avoids needless requests.
  return (
    <DiscoverProviderSlider
      source="simkl"
      configured={settings.currentSettings.simklConfigured}
      emptyMessage={
        requiresLink
          ? 'Link Simkl to view this list.'
          : 'No Simkl titles found.'
      }
      {...props}
    />
  );
};

export default SimklSlider;
