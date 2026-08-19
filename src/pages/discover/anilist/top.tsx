import DiscoverAnilistPage from '@app/components/Discover/DiscoverAnilist';
import type { NextPage } from 'next';

const AnilistTopPage: NextPage = () => (
  <DiscoverAnilistPage kind="top" endpoint="/api/v1/discover/anilist/top" />
);

export default AnilistTopPage;
