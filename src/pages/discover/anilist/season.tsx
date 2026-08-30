import DiscoverAnilistPage from '@app/components/Discover/DiscoverAnilist';

const AnilistSeasonPage = () => (
  <DiscoverAnilistPage
    kind="season"
    endpoint="/api/v1/discover/anilist/season"
  />
);

export default AnilistSeasonPage;
