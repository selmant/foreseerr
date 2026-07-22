import Slider from '@app/components/Slider';
import TmdbTitleCard from '@app/components/TitleCard/TmdbTitleCard';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { ArrowRightCircleIcon } from '@heroicons/react/24/outline';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import Link from 'next/link';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.Discover.TraktRecommendationsSlider',
  {
    traktrecommendations: 'Trakt Recommendations',
    empty:
      'Personalized Trakt recommendations will appear here after you link your account.',
  }
);

const TraktRecommendationsSlider = () => {
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

  const { data: items, error } = useSWR<{
    page: number;
    totalPages: number;
    totalResults: number;
    results: WatchlistItem[];
  }>(traktStatus?.connected ? '/api/v1/discover/trakt/recommendations' : null, {
    revalidateOnMount: true,
  });

  if (
    !settings.currentSettings.traktConfigured ||
    !traktStatus?.connected ||
    error
  ) {
    return null;
  }

  return (
    <>
      <div className="slider-header">
        <Link href="/discover/trakt/recommendations" className="slider-title">
          <span>{intl.formatMessage(messages.traktrecommendations)}</span>
          <ArrowRightCircleIcon />
        </Link>
      </div>
      <Slider
        sliderKey="trakt-recommendations"
        isLoading={!items}
        isEmpty={!!items && items.results.length === 0}
        emptyMessage={intl.formatMessage(messages.empty)}
        items={items?.results.map((item) => (
          <TmdbTitleCard
            id={item.tmdbId}
            key={`trakt-recs-slider-item-${item.ratingKey}`}
            tmdbId={item.tmdbId}
            type={item.mediaType}
            ratings={item.ratings}
          />
        ))}
      />
    </>
  );
};

export default TraktRecommendationsSlider;
