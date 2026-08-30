import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import useDiscover from '@app/hooks/useDiscover';
import { useRegisterHideWatchedRevalidation } from '@app/hooks/useRegisterHideWatchedRevalidation';
import useRouteQuery from '@app/hooks/useRouteQuery';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import type { MovieResult } from '@server/models/Search';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.DiscoverMovieGenre', {
  genreMovies: '{genre} Movies',
});

const DiscoverMovieGenre = () => {
  const query = useRouteQuery();
  const intl = useIntl();

  const {
    isLoadingInitialData,
    isEmpty,
    isLoadingMore,
    isReachingEnd,
    titles,
    fetchMore,
    error,
    firstResultData,
    mutate,
  } = useDiscover<MovieResult, { genre: { id: number; name: string } }>(
    `/api/v1/discover/movies/genre/${query.genreId}`
  );
  useRegisterHideWatchedRevalidation(mutate);

  if (error) {
    return <ErrorPage statusCode={500} />;
  }

  const title = isLoadingInitialData
    ? intl.formatMessage(globalMessages.loading)
    : intl.formatMessage(messages.genreMovies, {
        genre: firstResultData?.genre.name,
      });

  return (
    <>
      <PageTitle title={title} />
      <div className="mb-5 mt-1">
        <Header>{title}</Header>
      </div>
      <ListView
        items={titles}
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

export default DiscoverMovieGenre;
