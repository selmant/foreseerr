import { handleLibraryPlayClick } from '@app/components/Library/libraryPlayAction';
import { useNativeRuntime } from '@app/context/NativeRuntimeContext';
import type {
  LibraryItemInspectorResponse,
  LibraryTitle,
} from '@server/interfaces/api/libraryInterfaces';
import axios from 'axios';
import { useCallback } from 'react';

const useLibraryPlay = () => {
  const { play } = useNativeRuntime();

  const playItem = useCallback(
    async (
      event: { preventDefault: () => void },
      item: LibraryTitle,
      onNeedInspector?: (item: LibraryTitle) => void
    ) => {
      let itemId = item.playItemId;
      let fallbackUrl = item.mediaUrl ?? '';
      let label = item.subtitle || item.title;

      if (!itemId && item.mediaType === 'tv') {
        const inspectorId =
          item.inspectorItemId ?? item.jellyfinSeriesId ?? item.jellyfinItemId;
        try {
          const { data } = await axios.get<LibraryItemInspectorResponse>(
            `/api/v1/library/items/${inspectorId}`
          );
          itemId = data.playItemId;
          fallbackUrl = data.playUrl ?? data.mediaUrl ?? fallbackUrl;
          label = data.subtitle || data.title || label;
        } catch {
          onNeedInspector?.(item);
          return false;
        }
      }

      if (!itemId) {
        onNeedInspector?.(item);
        return false;
      }

      if (!fallbackUrl) {
        fallbackUrl = item.mediaUrl ?? '';
      }

      return handleLibraryPlayClick(event, play, {
        provider: 'jellyfin',
        itemId,
        fallbackUrl,
        label,
        quality: 'standard',
      });
    },
    [play]
  );

  return { play, playItem };
};

export default useLibraryPlay;
