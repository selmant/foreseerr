import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import { SliderSourceTitle } from '@app/components/Discover/SliderSourceMark';
import useDiscover from '@app/hooks/useDiscover';
import useSettings from '@app/hooks/useSettings';
import ErrorPage from '@app/pages/_error';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import { useRouter } from 'next/router';

const libraryStatuses = new Set([
  'watching',
  'plantowatch',
  'hold',
  'completed',
  'dropped',
]);

const DiscoverSimkl = () => {
  const settings = useSettings();
  const router = useRouter();
  const trending = router.query.view === 'trending';
  const status =
    typeof router.query.status === 'string' &&
    libraryStatuses.has(router.query.status)
      ? router.query.status
      : 'plantowatch';
  const title = trending
    ? 'Simkl Trending'
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
      ? trending
        ? '/api/v1/discover/simkl/trending'
        : '/api/v1/discover/simkl/library'
      : '',
    trending ? undefined : { status }
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
