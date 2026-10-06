import DiscoverAnilistPage from '@app/components/Discover/DiscoverAnilist';
import useRouteQuery from '@app/hooks/useRouteQuery';

const AnilistListPage = () => {
  const query = useRouteQuery();
  const name = typeof query.name === 'string' ? query.name : '';
  const url = typeof query.url === 'string' ? query.url : '';

  // A pasted public list link needs no linked account; the response names it.
  if (url) {
    return (
      <DiscoverAnilistPage
        kind="list"
        endpoint={`/api/v1/discover/anilist/list?url=${encodeURIComponent(url)}`}
      />
    );
  }

  return (
    <DiscoverAnilistPage
      kind="list"
      endpoint={
        name
          ? `/api/v1/discover/anilist/list?name=${encodeURIComponent(name)}`
          : ''
      }
      requiresLink
      title={name}
    />
  );
};

export default AnilistListPage;
