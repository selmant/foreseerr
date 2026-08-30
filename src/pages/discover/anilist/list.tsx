import DiscoverAnilistPage from '@app/components/Discover/DiscoverAnilist';
import useRouteQuery from '@app/hooks/useRouteQuery';

const AnilistListPage = () => {
  const query = useRouteQuery();
  const name = typeof query.name === 'string' ? query.name : '';

  return (
    <DiscoverAnilistPage
      kind="list"
      endpoint={
        name
          ? `/api/v1/discover/anilist/list?name=${encodeURIComponent(name)}`
          : ''
      }
      requiresLink
    />
  );
};

export default AnilistListPage;
