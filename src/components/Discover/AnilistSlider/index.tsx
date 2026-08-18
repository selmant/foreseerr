import Slider from '@app/components/Slider';
import TmdbTitleCard from '@app/components/TitleCard/TmdbTitleCard';
import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import { ArrowRightCircleIcon } from '@heroicons/react/24/outline';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import Link from 'next/link';
import { useEffect } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

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
  const { data, error } = useSWR<{ results: WatchlistItem[] }>(
    settings.currentSettings.anilistConfigured ? endpoint : null,
    { revalidateOnMount: true }
  );

  useEffect(() => {
    onNewTitles?.(data?.results.length ?? 0);
  }, [data?.results.length, onNewTitles]);

  if (!settings.currentSettings.anilistConfigured || error) {
    return null;
  }

  return (
    <>
      {!hideTitle && (
        <div className="slider-header">
          <Link href={linkUrl} className="slider-title">
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

export default AnilistSlider;
