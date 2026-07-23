import Slider from '@app/components/Slider';
import TmdbTitleCard from '@app/components/TitleCard/TmdbTitleCard';
import { encodeURIExtraParams } from '@app/hooks/useDiscover';
import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import { ArrowRightCircleIcon } from '@heroicons/react/24/outline';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import Link from 'next/link';
import { useEffect } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.TraktListSlider', {
  empty: 'No items found for this Trakt list.',
});

interface TraktListSliderProps {
  title: string;
  url: string;
  sliderKey: string;
  hideTitle?: boolean;
  onNewTitles?: (titleCount: number) => void;
}

const TraktListSlider = ({
  title,
  url,
  sliderKey,
  hideTitle = false,
  onNewTitles,
}: TraktListSliderProps) => {
  const intl = useIntl();
  const settings = useSettings();

  const { data, error } = useSWR<{
    results: WatchlistItem[];
  }>(
    settings.currentSettings.traktConfigured && url
      ? `/api/v1/discover/trakt/list?url=${encodeURIExtraParams(url)}`
      : null,
    { revalidateOnMount: true }
  );

  useEffect(() => {
    if (onNewTitles) {
      onNewTitles(data?.results.length ?? 0);
    }
  }, [data?.results.length, onNewTitles]);

  if (!settings.currentSettings.traktConfigured || !url || error) {
    return null;
  }

  return (
    <>
      {!hideTitle && (
        <div className="slider-header">
          <Link
            href={`/discover/trakt/list?url=${encodeURIComponent(url)}`}
            className="slider-title"
          >
            <span>{title}</span>
            <ArrowRightCircleIcon />
          </Link>
        </div>
      )}
      <Slider
        sliderKey={sliderKey}
        isLoading={!data}
        isEmpty={!!data && data.results.length === 0}
        emptyMessage={intl.formatMessage(messages.empty)}
        items={data?.results.map((item) => (
          <TmdbTitleCard
            id={item.tmdbId}
            key={`trakt-list-slider-item-${item.ratingKey}`}
            tmdbId={item.tmdbId}
            type={item.mediaType}
            ratings={item.ratings}
          />
        ))}
      />
    </>
  );
};

export default TraktListSlider;
