import DiscoverAnilistPage from '@app/components/Discover/DiscoverAnilist';

const AnilistPlanningPage = () => (
  <DiscoverAnilistPage
    kind="planning"
    endpoint="/api/v1/discover/anilist/planning"
    requiresLink
  />
);

export default AnilistPlanningPage;
