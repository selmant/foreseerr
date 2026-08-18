import DiscoverAnilistPage from '@app/components/Discover/DiscoverAnilist';
import type { NextPage } from 'next';

const AnilistTrendingPage: NextPage = () => (
  <DiscoverAnilistPage
    kind="trending"
    endpoint="/api/v1/discover/anilist/trending"
  />
);

export default AnilistTrendingPage;
