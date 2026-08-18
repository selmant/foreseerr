import DiscoverAnilistPage from '@app/components/Discover/DiscoverAnilist';
import type { NextPage } from 'next';
import { useRouter } from 'next/router';

const AnilistListPage: NextPage = () => {
  const router = useRouter();
  const name = typeof router.query.name === 'string' ? router.query.name : '';

  return (
    <DiscoverAnilistPage
      kind="list"
      endpoint={
        name
          ? `/api/v1/discover/anilist/list?name=${encodeURIComponent(name)}`
          : ''
      }
      requiresLink
    />
  );
};

export default AnilistListPage;
