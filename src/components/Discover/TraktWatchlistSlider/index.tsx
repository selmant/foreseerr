import { DiscoverSliderTitle } from '@app/components/Discover/SliderSourceMark';
import Slider from '@app/components/Slider';
import TmdbTitleCard from '@app/components/TitleCard/TmdbTitleCard';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.TraktWatchlistSlider', {
  traktwatchlist: 'Trakt Watchlist',
  emptywatchlist:
    'Items on your Trakt watchlist will appear here after you link your account.',
});

const TraktWatchlistSlider = () => {
  const intl = useIntl();
  const settings = useSettings();
  const { user } = useUser();
  const { data: traktStatus } = useSWR<{
    connected: boolean;
    username: string | null;
  }>(
    settings.currentSettings.traktConfigured && user
      ? `/api/v1/user/${user.id}/settings/linked-accounts/trakt`
      : null
  );

  const { data: watchlistItems, error: watchlistError } = useSWR<{
    results: WatchlistItem[];
  }>(traktStatus?.connected ? '/api/v1/discover/trakt/watchlist' : null, {
    revalidateOnMount: true,
  });

  if (
    !settings.currentSettings.traktConfigured ||
    !traktStatus?.connected ||
    watchlistError
  ) {
    return null;
  }

  return (
    <>
      <DiscoverSliderTitle href="/discover/trakt/watchlist" source="trakt">
        {intl.formatMessage(messages.traktwatchlist)}
      </DiscoverSliderTitle>
      <Slider
        sliderKey="trakt-watchlist"
        isLoading={!watchlistItems}
        isEmpty={!!watchlistItems && watchlistItems.results.length === 0}
        emptyMessage={intl.formatMessage(messages.emptywatchlist)}
        items={watchlistItems?.results.map((item) => (
          <TmdbTitleCard
            id={item.tmdbId}
            key={`trakt-watchlist-slider-item-${item.ratingKey}`}
            tmdbId={item.tmdbId}
            type={item.mediaType}
            ratings={item.ratings}
          />
        ))}
      />
    </>
  );
};

export default TraktWatchlistSlider;
