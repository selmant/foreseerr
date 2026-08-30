import DiscoverAnilistPage from '@app/components/Discover/DiscoverAnilist';

const AnilistTopPage = () => (
  <DiscoverAnilistPage kind="top" endpoint="/api/v1/discover/anilist/top" />
);

export default AnilistTopPage;
