import DiscoverAnilistPage from '@app/components/Discover/DiscoverAnilist';

const AnilistTrendingPage = () => (
  <DiscoverAnilistPage
    kind="trending"
    endpoint="/api/v1/discover/anilist/trending"
  />
);

export default AnilistTrendingPage;
