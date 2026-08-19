import { DiscoverSliderTitle } from '@app/components/Discover/SliderSourceMark';
import Slider from '@app/components/Slider';
import TmdbTitleCard from '@app/components/TitleCard/TmdbTitleCard';
import { encodeURIExtraParams } from '@app/hooks/useDiscover';
import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import { useEffect } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

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

  const { data, error } = useSWR<{
    results: WatchlistItem[];
  }>(
    settings.currentSettings.mdblistConfigured && url
      ? `/api/v1/discover/mdblist/list?url=${encodeURIExtraParams(url)}`
      : null,
    { revalidateOnMount: true }
  );

  useEffect(() => {
    if (onNewTitles) {
      onNewTitles(data?.results.length ?? 0);
    }
  }, [data?.results.length, onNewTitles]);

  if (!settings.currentSettings.mdblistConfigured || !url || error) {
    return null;
  }

  return (
    <>
      {!hideTitle && (
        <DiscoverSliderTitle
          href={`/discover/mdblist/list?url=${encodeURIComponent(url)}`}
          source="mdblist"
        >
          {title}
        </DiscoverSliderTitle>
      )}
      <Slider
        sliderKey={sliderKey}
        isLoading={!data}
        isEmpty={!!data && data.results.length === 0}
        emptyMessage={intl.formatMessage(messages.empty)}
        items={data?.results.map((item) => (
          <TmdbTitleCard
            id={item.tmdbId}
            key={`mdblist-list-slider-item-${item.ratingKey}`}
            tmdbId={item.tmdbId}
            type={item.mediaType}
            ratings={item.ratings}
          />
        ))}
      />
    </>
  );
};

export default MdblistListSlider;
