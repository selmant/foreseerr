import DiscoverAnilistPage from '@app/components/Discover/DiscoverAnilist';
import type { NextPage } from 'next';

const AnilistCompletedPage: NextPage = () => (
  <DiscoverAnilistPage
    kind="completed"
    endpoint="/api/v1/discover/anilist/completed"
    requiresLink
  />
);

export default AnilistCompletedPage;
