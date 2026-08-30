import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import { SliderSourceTitle } from '@app/components/Discover/SliderSourceMark';
import useDiscover from '@app/hooks/useDiscover';
import useRouteQuery from '@app/hooks/useRouteQuery';
import useSettings from '@app/hooks/useSettings';
import ErrorPage from '@app/pages/_error';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';

const libraryStatuses = new Set([
  'watching',
  'plantowatch',
  'hold',
  'completed',
  'dropped',
]);

const publicViews = {
  trending: {
    title: 'Simkl Trending',
    endpoint: '/api/v1/discover/simkl/trending',
    options: undefined,
  },
  'best-tv': {
    title: 'Simkl Best TV',
    endpoint: '/api/v1/discover/simkl/best',
    options: { mediaType: 'tv' },
  },
  'best-anime': {
    title: 'Simkl Best Anime',
    endpoint: '/api/v1/discover/simkl/best',
    options: { mediaType: 'anime' },
  },
  'new-tv-premieres': {
    title: 'Simkl New TV Premieres',
    endpoint: '/api/v1/discover/simkl/premieres',
    options: { mediaType: 'tv', window: 'new' },
  },
  'upcoming-tv-premieres': {
    title: 'Simkl Upcoming TV Premieres',
    endpoint: '/api/v1/discover/simkl/premieres',
    options: { mediaType: 'tv', window: 'upcoming' },
  },
  'new-anime-premieres': {
    title: 'Simkl New Anime Premieres',
    endpoint: '/api/v1/discover/simkl/premieres',
    options: { mediaType: 'anime', window: 'new' },
  },
  'upcoming-anime-premieres': {
    title: 'Simkl Upcoming Anime Premieres',
    endpoint: '/api/v1/discover/simkl/premieres',
    options: { mediaType: 'anime', window: 'upcoming' },
  },
} as const;

const DiscoverSimkl = () => {
  const settings = useSettings();
  const query = useRouteQuery();
  const view =
    typeof query.view === 'string'
      ? publicViews[query.view as keyof typeof publicViews]
      : undefined;
  const status =
    typeof query.status === 'string' && libraryStatuses.has(query.status)
      ? query.status
      : 'plantowatch';
  const title = view
    ? view.title
    : `Simkl ${
        status === 'plantowatch'
          ? 'Plan to Watch'
          : status[0].toUpperCase() + status.slice(1)
      }`;
  const {
    isLoadingInitialData,
    isEmpty,
    isLoadingMore,
    isReachingEnd,
    titles,
    fetchMore,
    error,
  } = useDiscover<WatchlistItem>(
    settings.currentSettings.simklConfigured
      ? view
        ? view.endpoint
        : '/api/v1/discover/simkl/library'
      : '',
    view ? view.options : { status }
  );
  if (!settings.currentSettings.simklConfigured)
    return <ErrorPage statusCode={404} />;
  if (error) return <ErrorPage statusCode={500} />;
  return (
    <>
      <PageTitle title={title} />
      <div className="mb-5 mt-1">
        <Header>
          <SliderSourceTitle source="simkl">{title}</SliderSourceTitle>
        </Header>
      </div>
      <ListView
        plexItems={titles}
        isEmpty={isEmpty}
        isLoading={
          isLoadingInitialData || (isLoadingMore && (titles?.length ?? 0) > 0)
        }
        isReachingEnd={isReachingEnd}
        onScrollBottom={fetchMore}
      />
    </>
  );
};

export default DiscoverSimkl;
