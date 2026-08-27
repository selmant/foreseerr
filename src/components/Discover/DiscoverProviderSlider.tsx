import type { DiscoverSliderSource } from '@app/components/Discover/SliderSourceMark';
import { DiscoverSliderTitle } from '@app/components/Discover/SliderSourceMark';
import Slider from '@app/components/Slider';
import TmdbTitleCard, {
  watchlistTitleCardProps,
} from '@app/components/TitleCard/TmdbTitleCard';
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
  /** Same as MediaSlider: hide the row entirely when the provider returns no titles. */
  hideWhenEmpty?: boolean;
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
  hideWhenEmpty = false,
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

  if (hideWhenEmpty && data && data.results.length === 0) {
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
            key={`${sliderKey}-${item.ratingKey}`}
            {...watchlistTitleCardProps(item)}
          />
        ))}
      />
    </>
  );
};

export default DiscoverProviderSlider;
