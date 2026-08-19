import DiscoverAnilistPage from '@app/components/Discover/DiscoverAnilist';
import type { NextPage } from 'next';

const AnilistPopularPage: NextPage = () => (
  <DiscoverAnilistPage
    kind="popular"
    endpoint="/api/v1/discover/anilist/popular"
  />
);

export default AnilistPopularPage;
