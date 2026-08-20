import TraktSlider from '@app/components/Discover/TraktSlider';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.TraktWatchlistSlider', {
  traktwatchlist: 'Trakt Watchlist',
  emptywatchlist:
    'Items on your Trakt watchlist will appear here after you link your account.',
});

const TraktWatchlistSlider = () => {
  const intl = useIntl();

  return (
    <TraktSlider
      title={intl.formatMessage(messages.traktwatchlist)}
      href="/discover/trakt/watchlist"
      endpoint="/api/v1/discover/trakt/watchlist"
      sliderKey="trakt-watchlist"
      emptyMessage={intl.formatMessage(messages.emptywatchlist)}
      requiresLinkedAccount
    />
  );
};

export default TraktWatchlistSlider;
