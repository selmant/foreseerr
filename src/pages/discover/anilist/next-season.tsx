import DiscoverAnilistPage from '@app/components/Discover/DiscoverAnilist';

const AnilistNextSeasonPage = () => (
  <DiscoverAnilistPage
    kind="nextSeason"
    endpoint="/api/v1/discover/anilist/next-season"
  />
);

export default AnilistNextSeasonPage;
