import Slider from '@app/components/Slider';
import TmdbTitleCard, {
  watchlistTitleCardProps,
} from '@app/components/TitleCard/TmdbTitleCard';
import { useUser } from '@app/hooks/useUser';
import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import { ArrowRightCircleIcon } from '@heroicons/react/24/outline';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import { useIntl } from 'react-intl';
import { Link } from 'react-router';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.PlexWatchlistSlider', {
  plexwatchlist: 'Your Watchlist',
  emptywatchlist:
    'Media added to your <PlexWatchlistSupportLink>Plex Watchlist</PlexWatchlistSupportLink> will appear here.',
});

const PlexWatchlistSlider = () => {
  const intl = useIntl();
  const { user } = useUser();
  const settings = useSettings();

  const { data: watchlistItems, error: watchlistError } = useSWR<{
    page: number;
    totalPages: number;
    totalResults: number;
    results: WatchlistItem[];
  }>('/api/v1/discover/watchlist', {
    revalidateOnMount: true,
  });
  const titles = settings.currentSettings.hideRequested
    ? watchlistItems?.results.filter((item) => !item.hasActiveRequest)
    : watchlistItems?.results;

  if (
    (watchlistItems &&
      titles?.length === 0 &&
      !user?.settings?.watchlistSyncMovies &&
      !user?.settings?.watchlistSyncTv) ||
    watchlistError
  ) {
    return null;
  }

  return (
    <>
      <div className="slider-header">
        <Link to="/discover/watchlist" className="slider-title">
          <span>{intl.formatMessage(messages.plexwatchlist)}</span>
          <ArrowRightCircleIcon />
        </Link>
      </div>
      <Slider
        sliderKey="watchlist"
        isLoading={!watchlistItems}
        isEmpty={!!watchlistItems && titles?.length === 0}
        emptyMessage={intl.formatMessage(messages.emptywatchlist, {
          PlexWatchlistSupportLink: (msg: React.ReactNode) => (
            <a
              href="https://support.plex.tv/articles/universal-watchlist/"
              className="text-white transition duration-300 hover:underline"
              target="_blank"
              rel="noreferrer"
            >
              {msg}
            </a>
          ),
        })}
        items={titles?.map((item) => (
          <TmdbTitleCard
            key={`watchlist-slider-item-${item.ratingKey}`}
            {...watchlistTitleCardProps(item)}
            isAddedToWatchlist={true}
          />
        ))}
      />
    </>
  );
};

export default PlexWatchlistSlider;
