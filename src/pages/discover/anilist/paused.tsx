import DiscoverAnilistPage from '@app/components/Discover/DiscoverAnilist';

const AnilistPausedPage = () => (
  <DiscoverAnilistPage
    kind="paused"
    endpoint="/api/v1/discover/anilist/paused"
    requiresLink
  />
);

export default AnilistPausedPage;
