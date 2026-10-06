import DiscoverAnilistPage from '@app/components/Discover/DiscoverAnilist';

const AnilistDroppedPage = () => (
  <DiscoverAnilistPage
    kind="dropped"
    endpoint="/api/v1/discover/anilist/dropped"
    requiresLink
  />
);

export default AnilistDroppedPage;
