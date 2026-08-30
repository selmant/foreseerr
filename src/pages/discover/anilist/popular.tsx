import DiscoverAnilistPage from '@app/components/Discover/DiscoverAnilist';

const AnilistPopularPage = () => (
  <DiscoverAnilistPage
    kind="popular"
    endpoint="/api/v1/discover/anilist/popular"
  />
);

export default AnilistPopularPage;
