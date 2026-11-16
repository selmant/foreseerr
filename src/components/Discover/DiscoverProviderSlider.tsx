import type { DiscoverSliderSource } from '@app/components/Discover/SliderSourceMark';
import { DiscoverSliderTitle } from '@app/components/Discover/SliderSourceMark';
import Slider from '@app/components/Slider';
import TmdbTitleCard, {
  watchlistTitleCardProps,
} from '@app/components/TitleCard/TmdbTitleCard';
import useSeeMorePosters from '@app/hooks/useSeeMorePosters';
import useSettings from '@app/hooks/useSettings';
import type {
  WatchlistItem,
  WatchlistResponse,
} from '@shared/interfaces/api/discoverInterfaces';
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
  fetcher?: (endpoint: string) => Promise<WatchlistResponse>;
  transformResults?: (items: WatchlistItem[]) => WatchlistItem[];
  itemLimit?: number;
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
  fetcher,
  transformResults,
  itemLimit,
}: DiscoverProviderSliderProps) => {
  const settings = useSettings();
  const { data, error } = useSWR<WatchlistResponse>(
    configured ? endpoint : null,
    { revalidateOnMount: true, ...(fetcher ? { fetcher } : {}) }
  );
  const orderedResults =
    data && transformResults ? transformResults(data.results) : data?.results;
  const filteredTitles = settings.currentSettings.hideRequested
    ? orderedResults?.filter((item) => !item.hasActiveRequest)
    : orderedResults;
  const titles = itemLimit
    ? filteredTitles?.slice(0, itemLimit)
    : filteredTitles;
  const nextPagePosters = useSeeMorePosters(
    configured ? endpoint : null,
    data,
    settings.currentSettings.hideRequested
  );

  const seeMorePosters = itemLimit
    ? filteredTitles
        ?.slice(itemLimit, itemLimit + 4)
        .map((item) => item.image || item.posterPath)
    : nextPagePosters;

  useEffect(() => {
    onNewTitles?.(titles?.length ?? 0);
  }, [titles?.length, onNewTitles]);

  if (!configured || !endpoint || error) {
    return null;
  }

  if (hideWhenEmpty && data && titles?.length === 0) {
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
        ariaLabel={title}
        seeMore={{
          url: linkUrl,
          posters: seeMorePosters,
        }}
        isLoading={!data}
        isEmpty={!!data && titles?.length === 0}
        emptyMessage={emptyMessage}
        items={titles?.map((item) => (
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
