import { useUser } from '@app/hooks/useUser';
import type { DiscoverFilterDefaults } from '@server/lib/discover/filterDefaults';
import useSWR from 'swr';

export const useDiscoverFilterDefaults = () => {
  const { user } = useUser();
  return useSWR<DiscoverFilterDefaults>(
    user ? `/api/v1/user/${user.id}/settings/discover` : null
  );
};
