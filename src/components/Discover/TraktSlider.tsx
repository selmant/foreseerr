import { DiscoverSliderTitle } from '@app/components/Discover/SliderSourceMark';
import Slider from '@app/components/Slider';
import TmdbTitleCard from '@app/components/TitleCard/TmdbTitleCard';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import { useEffect } from 'react';
import useSWR from 'swr';

interface TraktSliderProps {
  title: string;
  href: string;
  endpoint: string | null;
  sliderKey: string;
  emptyMessage: string;
  requiresLinkedAccount?: boolean;
  hideTitle?: boolean;
  onNewTitles?: (titleCount: number) => void;
}

/** Shared provider/account gating and title-card rendering for Trakt sliders. */
const TraktSlider = ({
  title,
  href,
  endpoint,
  sliderKey,
  emptyMessage,
  requiresLinkedAccount = false,
  hideTitle = false,
  onNewTitles,
}: TraktSliderProps) => {
  const settings = useSettings();
  const { user } = useUser();
  const { data: traktStatus } = useSWR<{
    connected: boolean;
    username: string | null;
  }>(
    requiresLinkedAccount && settings.currentSettings.traktConfigured && user
      ? `/api/v1/user/${user.id}/settings/linked-accounts/trakt`
      : null
  );
  const canLoad =
    settings.currentSettings.traktConfigured &&
    endpoint &&
    (!requiresLinkedAccount || traktStatus?.connected === true);
  const { data, error } = useSWR<{ results: WatchlistItem[] }>(
    canLoad ? endpoint : null,
    { revalidateOnMount: true }
  );

  useEffect(() => {
    onNewTitles?.(data?.results.length ?? 0);
  }, [data?.results.length, onNewTitles]);

  if (
    !settings.currentSettings.traktConfigured ||
    !endpoint ||
    (requiresLinkedAccount && !traktStatus?.connected) ||
    error
  ) {
    return null;
  }

  return (
    <>
      {!hideTitle && (
        <DiscoverSliderTitle href={href} source="trakt">
          {title}
        </DiscoverSliderTitle>
      )}
      <Slider
        sliderKey={sliderKey}
        isLoading={!data}
        isEmpty={!!data && data.results.length === 0}
        emptyMessage={emptyMessage}
        items={data?.results.map((item) => (
          <TmdbTitleCard
            id={item.tmdbId}
            key={`${sliderKey}-item-${item.ratingKey}`}
            tmdbId={item.tmdbId}
            type={item.mediaType}
            ratings={item.ratings}
          />
        ))}
      />
    </>
  );
};

export default TraktSlider;
