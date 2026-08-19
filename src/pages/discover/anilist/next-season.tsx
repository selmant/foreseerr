import DiscoverAnilistPage from '@app/components/Discover/DiscoverAnilist';
import type { NextPage } from 'next';

const AnilistNextSeasonPage: NextPage = () => (
  <DiscoverAnilistPage
    kind="nextSeason"
    endpoint="/api/v1/discover/anilist/next-season"
  />
);

export default AnilistNextSeasonPage;
