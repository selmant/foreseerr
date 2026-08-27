import DiscoverProviderSlider from '@app/components/Discover/DiscoverProviderSlider';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import useSWR from 'swr';

interface SimklSliderProps {
  title: string;
  endpoint: string;
  linkUrl: string;
  sliderKey: string;
  requiresLink?: boolean;
}

const SimklSlider = ({ requiresLink = false, ...props }: SimklSliderProps) => {
  const settings = useSettings();
  const { user } = useUser();
  const { data: linkStatus } = useSWR<{ connected: boolean }>(
    requiresLink && user && settings.currentSettings.simklConfigured
      ? `/api/v1/user/${user.id}/settings/linked-accounts/simkl`
      : null
  );

  return (
    <DiscoverProviderSlider
      source="simkl"
      configured={
        settings.currentSettings.simklConfigured &&
        (!requiresLink || linkStatus?.connected === true)
      }
      emptyMessage={
        requiresLink
          ? 'Link Simkl to view this list.'
          : 'No Simkl titles found.'
      }
      {...props}
      hideWhenEmpty
    />
  );
};

export default SimklSlider;
