import DiscoverAnilistPage from '@app/components/Discover/DiscoverAnilist';

const AnilistWatchingPage = () => (
  <DiscoverAnilistPage
    kind="watching"
    endpoint="/api/v1/discover/anilist/watching"
    requiresLink
  />
);

export default AnilistWatchingPage;
