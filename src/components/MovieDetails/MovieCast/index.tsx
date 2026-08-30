import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import PersonCard from '@app/components/PersonCard';
import useRouteQuery from '@app/hooks/useRouteQuery';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import type { MovieDetails } from '@server/models/Movie';
import { useIntl } from 'react-intl';
import { Link } from 'react-router';
import useSWR from 'swr';

const messages = defineMessages('components.MovieDetails.MovieCast', {
  fullcast: 'Full Cast',
});

const MovieCast = () => {
  const routeQuery = useRouteQuery();
  const intl = useIntl();
  const { data, error } = useSWR<MovieDetails>(
    `/api/v1/movie/${routeQuery.movieId}`
  );

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return <ErrorPage statusCode={404} />;
  }

  return (
    <>
      <PageTitle title={[intl.formatMessage(messages.fullcast), data.title]} />
      <div className="mb-5 mt-1">
        <Header
          subtext={
            <Link to={`/movie/${data.id}`} className="hover:underline">
              {data.title}
            </Link>
          }
        >
          {intl.formatMessage(messages.fullcast)}
        </Header>
      </div>
      <ul className="cards-vertical">
        {data?.credits.cast.map((person, index) => {
          return (
            <li key={`cast-${person.id}-${index}`}>
              <PersonCard
                name={person.name}
                personId={person.id}
                subName={person.character}
                profilePath={person.profilePath}
                canExpand
              />
            </li>
          );
        })}
      </ul>
    </>
  );
};

export default MovieCast;
