import type { DiscoverSliderSource } from '@app/components/Discover/SliderSourceMark';
import { DiscoverSliderTitle } from '@app/components/Discover/SliderSourceMark';
import Slider from '@app/components/Slider';
import TmdbTitleCard from '@app/components/TitleCard/TmdbTitleCard';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import { useEffect } from 'react';
import useSWR from 'swr';

interface DiscoverProviderSliderProps {
  source: DiscoverSliderSource;
  configured: boolean;
  title: string;
  endpoint: string | null;
  linkUrl: string;
  sliderKey: string;
  emptyMessage: string;
  hideTitle?: boolean;
  onNewTitles?: (titleCount: number) => void;
}

/** Common provider-backed slider lifecycle and title-card rendering. */
const DiscoverProviderSlider = ({
  source,
  configured,
  title,
  endpoint,
  linkUrl,
  sliderKey,
  emptyMessage,
  hideTitle = false,
  onNewTitles,
}: DiscoverProviderSliderProps) => {
  const { data, error } = useSWR<{ results: WatchlistItem[] }>(
    configured ? endpoint : null,
    { revalidateOnMount: true }
  );

  useEffect(() => {
    onNewTitles?.(data?.results.length ?? 0);
  }, [data?.results.length, onNewTitles]);

  if (!configured || !endpoint || error) {
    return null;
  }

  return (
    <>
      {!hideTitle && (
        <DiscoverSliderTitle href={linkUrl} source={source}>
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
            key={`${sliderKey}-${item.ratingKey}`}
            tmdbId={item.tmdbId}
            type={item.mediaType}
            ratings={item.ratings}
          />
        ))}
      />
    </>
  );
};

export default DiscoverProviderSlider;
