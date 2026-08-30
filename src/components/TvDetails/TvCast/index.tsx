import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import PersonCard from '@app/components/PersonCard';
import useRouteQuery from '@app/hooks/useRouteQuery';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import type { TvDetails } from '@server/models/Tv';
import { useIntl } from 'react-intl';
import { Link } from 'react-router';
import useSWR from 'swr';

const messages = defineMessages('components.TvDetails.TvCast', {
  fullseriescast: 'Full Series Cast',
});

const TvCast = () => {
  const routeQuery = useRouteQuery();
  const intl = useIntl();
  const { data, error } = useSWR<TvDetails>(`/api/v1/tv/${routeQuery.tvId}`);

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return <ErrorPage statusCode={404} />;
  }

  return (
    <>
      <PageTitle
        title={[intl.formatMessage(messages.fullseriescast), data.name]}
      />
      <div className="mb-5 mt-1">
        <Header
          subtext={
            <Link to={`/tv/${data.id}`} className="hover:underline">
              {data.name}
            </Link>
          }
        >
          {intl.formatMessage(messages.fullseriescast)}
        </Header>
      </div>
      <ul className="cards-vertical">
        {data?.credits.cast.map((person) => {
          return (
            <li key={person.id}>
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

export default TvCast;
