import type { LibraryItemInspectorResponse } from '@server/interfaces/api/libraryInterfaces';
import useSWR from 'swr';

/**
 * The signed-in user's Jellyfin view of a title (progress, next episode,
 * seasons). Undefined while loading or when the library cannot answer.
 */
const useLibraryItem = (jellyfinItemId?: string | null) => {
  const { data } = useSWR<LibraryItemInspectorResponse>(
    jellyfinItemId ? `/api/v1/library/items/${jellyfinItemId}` : null,
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  return data && !data.code ? data : undefined;
};

/** "S1E2" from the server's "Up next S1E2" play target; rewatches excluded. */
export const upNextEpisodeCode = (item?: LibraryItemInspectorResponse) =>
  item?.subtitle?.match(/^Up next (S\d+E\d+)$/)?.[1];

export default useLibraryItem;
