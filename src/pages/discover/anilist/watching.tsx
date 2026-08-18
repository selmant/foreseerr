import DiscoverAnilistPage from '@app/components/Discover/DiscoverAnilist';
import type { NextPage } from 'next';

const AnilistWatchingPage: NextPage = () => (
  <DiscoverAnilistPage
    kind="watching"
    endpoint="/api/v1/discover/anilist/watching"
    requiresLink
  />
);

export default AnilistWatchingPage;
