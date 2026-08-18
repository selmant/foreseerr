import DiscoverAnilistPage from '@app/components/Discover/DiscoverAnilist';
import type { NextPage } from 'next';

const AnilistSeasonPage: NextPage = () => (
  <DiscoverAnilistPage
    kind="season"
    endpoint="/api/v1/discover/anilist/season"
  />
);

export default AnilistSeasonPage;
