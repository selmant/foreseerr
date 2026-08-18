import AnilistSlider from '@app/components/Discover/AnilistSlider';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.AnilistUserSlider', {
  watching: 'AniList Watching',
  planning: 'AniList Planning',
  completed: 'AniList Completed',
});

type AnilistUserList = 'watching' | 'planning' | 'completed';

interface AnilistUserSliderProps {
  list: AnilistUserList;
  title?: string;
  sliderKey?: string;
  hideTitle?: boolean;
  onNewTitles?: (titleCount: number) => void;
}

const AnilistUserSlider = ({
  list,
  title,
  sliderKey,
  hideTitle,
  onNewTitles,
}: AnilistUserSliderProps) => {
  const intl = useIntl();
  const settings = useSettings();
  const { user } = useUser();
  const { data: anilistStatus } = useSWR<{
    connected: boolean;
    username: string | null;
  }>(
    settings.currentSettings.anilistConfigured && user
      ? `/api/v1/user/${user.id}/settings/linked-accounts/anilist`
      : null
  );

  const defaultTitle = intl.formatMessage(messages[list]);

  if (!anilistStatus?.connected) {
    return null;
  }

  return (
    <AnilistSlider
      title={title ?? defaultTitle}
      endpoint={`/api/v1/discover/anilist/${list}`}
      linkUrl={`/discover/anilist/${list}`}
      sliderKey={sliderKey ?? `anilist-${list}`}
      hideTitle={hideTitle}
      onNewTitles={onNewTitles}
    />
  );
};

export default AnilistUserSlider;
