import Slider from '@app/components/Slider';
import TmdbTitleCard from '@app/components/TitleCard/TmdbTitleCard';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { ArrowRightCircleIcon } from '@heroicons/react/24/outline';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import Link from 'next/link';
import { useEffect } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.TraktHistorySlider', {
  trakthistory: 'Trakt History',
  emptyhistory:
    'Titles you mark watched on Trakt will appear here after you link your account.',
});

interface TraktHistorySliderProps {
  title?: string;
  sliderKey?: string;
  hideTitle?: boolean;
  onNewTitles?: (titleCount: number) => void;
}

const TraktHistorySlider = ({
  title,
  sliderKey = 'trakt-history',
  hideTitle = false,
  onNewTitles,
}: TraktHistorySliderProps = {}) => {
  const intl = useIntl();
  const settings = useSettings();
  const { user } = useUser();
  const displayTitle = title ?? intl.formatMessage(messages.trakthistory);
  const { data: traktStatus } = useSWR<{
    connected: boolean;
    username: string | null;
  }>(
    settings.currentSettings.traktConfigured && user
      ? `/api/v1/user/${user.id}/settings/linked-accounts/trakt`
      : null
  );

  const { data: historyItems, error: historyError } = useSWR<{
    results: WatchlistItem[];
  }>(traktStatus?.connected ? '/api/v1/discover/trakt/history' : null, {
    revalidateOnMount: true,
  });

  useEffect(() => {
    if (onNewTitles) {
      onNewTitles(historyItems?.results.length ?? 0);
    }
  }, [historyItems?.results.length, onNewTitles]);

  if (
    !settings.currentSettings.traktConfigured ||
    !traktStatus?.connected ||
    historyError
  ) {
    return null;
  }

  return (
    <>
      {!hideTitle && (
        <div className="slider-header">
          <Link href="/discover/trakt/history" className="slider-title">
            <span>{displayTitle}</span>
            <ArrowRightCircleIcon />
          </Link>
        </div>
      )}
      <Slider
        sliderKey={sliderKey}
        isLoading={!historyItems}
        isEmpty={!!historyItems && historyItems.results.length === 0}
        emptyMessage={intl.formatMessage(messages.emptyhistory)}
        items={historyItems?.results.map((item) => (
          <TmdbTitleCard
            id={item.tmdbId}
            key={`trakt-history-slider-item-${item.ratingKey}`}
            tmdbId={item.tmdbId}
            type={item.mediaType}
            ratings={item.ratings}
          />
        ))}
      />
    </>
  );
};

export default TraktHistorySlider;
