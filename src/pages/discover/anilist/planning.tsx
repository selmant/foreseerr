import DiscoverAnilistPage from '@app/components/Discover/DiscoverAnilist';
import type { NextPage } from 'next';

const AnilistPlanningPage: NextPage = () => (
  <DiscoverAnilistPage
    kind="planning"
    endpoint="/api/v1/discover/anilist/planning"
    requiresLink
  />
);

export default AnilistPlanningPage;
