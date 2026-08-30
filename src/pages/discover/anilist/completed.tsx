import DiscoverAnilistPage from '@app/components/Discover/DiscoverAnilist';

const AnilistCompletedPage = () => (
  <DiscoverAnilistPage
    kind="completed"
    endpoint="/api/v1/discover/anilist/completed"
    requiresLink
  />
);

export default AnilistCompletedPage;
