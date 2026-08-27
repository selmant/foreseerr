import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import { SliderSourceTitle } from '@app/components/Discover/SliderSourceMark';
import useDiscover from '@app/hooks/useDiscover';
import useSettings from '@app/hooks/useSettings';
import ErrorPage from '@app/pages/_error';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';

const DiscoverSimkl = () => {
  const settings = useSettings();
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
      ? '/api/v1/discover/simkl/library'
      : '',
    { status: 'plantowatch' }
  );
  if (!settings.currentSettings.simklConfigured)
    return <ErrorPage statusCode={404} />;
  if (error) return <ErrorPage statusCode={500} />;
  return (
    <>
      <PageTitle title="Simkl Plan to Watch" />
      <div className="mb-5 mt-1">
        <Header>
          <SliderSourceTitle source="simkl">
            Simkl Plan to Watch
          </SliderSourceTitle>
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
