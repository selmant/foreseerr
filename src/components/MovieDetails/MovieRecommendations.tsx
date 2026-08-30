import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import useDiscover from '@app/hooks/useDiscover';
import useRouteQuery from '@app/hooks/useRouteQuery';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import type { MovieDetails } from '@server/models/Movie';
import type { MovieResult } from '@server/models/Search';
import { useIntl } from 'react-intl';
import { Link } from 'react-router';
import useSWR from 'swr';

const messages = defineMessages('components.MovieDetails', {
  recommendations: 'Recommendations',
});

const MovieRecommendations = () => {
  const intl = useIntl();
  const routeQuery = useRouteQuery();
  const { data: movieData } = useSWR<MovieDetails>(
    `/api/v1/movie/${routeQuery.movieId}`
  );
  const {
    isLoadingInitialData,
    isEmpty,
    isLoadingMore,
    isReachingEnd,
    titles,
    fetchMore,
    error,
  } = useDiscover<MovieResult>(
    `/api/v1/movie/${routeQuery.movieId}/recommendations`
  );

  if (error) {
    return <ErrorPage statusCode={500} />;
  }

  return (
    <>
      <PageTitle
        title={[intl.formatMessage(messages.recommendations), movieData?.title]}
      />
      <div className="mb-5 mt-1">
        <Header
          subtext={
            <Link to={`/movie/${movieData?.id}`} className="hover:underline">
              {movieData?.title}
            </Link>
          }
        >
          {intl.formatMessage(messages.recommendations)}
        </Header>
      </div>
      <ListView
        items={titles}
        isEmpty={isEmpty}
        isReachingEnd={isReachingEnd}
        isLoading={
          isLoadingInitialData || (isLoadingMore && (titles?.length ?? 0) > 0)
        }
        onScrollBottom={fetchMore}
      />
    </>
  );
};

export default MovieRecommendations;
