import {
  handleLibraryPlayClick,
  navigatePlayFallback,
  shouldNavigatePlayFallback,
} from '@app/components/Library/libraryPlayAction';
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
      let alreadyPreventedDefault = false;

      if (!itemId && item.mediaType === 'tv') {
        // Inspector lookup is async; stop the overview <a href> until we know
        // the concrete episode URL.
        event.preventDefault();
        alreadyPreventedDefault = true;
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

      const admitted = handleLibraryPlayClick(event, play, {
        provider: 'jellyfin',
        itemId,
        fallbackUrl,
        label,
        quality: 'standard',
      });

      if (
        shouldNavigatePlayFallback(
          admitted,
          alreadyPreventedDefault,
          fallbackUrl
        )
      ) {
        navigatePlayFallback(fallbackUrl);
        return true;
      }

      return admitted;
    },
    [play]
  );

  return { play, playItem };
};

export default useLibraryPlay;
