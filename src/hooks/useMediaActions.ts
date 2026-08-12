import {
  invalidateMediaActionCaches,
  mediaActionStatusKey,
} from '@app/utils/mediaActionInvalidation';
import {
  writeSucceeded,
  type MediaActionProviderResult,
  type MediaActionWriteResponse,
} from '@app/utils/mediaActions';
import axios from 'axios';
import { useCallback, useState } from 'react';
import useSWR from 'swr';

export interface MediaActionCapabilitiesResponse {
  movie: { watched: boolean; rating: boolean };
  tv: { watched: boolean; rating: boolean };
  episode: { watched: boolean; rating: boolean };
  providers: {
    id: 'trakt' | 'jellyfin';
    linked: boolean;
    capabilities: {
      readWatched: boolean;
      writeWatched: boolean;
      readRating: boolean;
      writeRating: boolean;
    };
  }[];
}

export interface MediaActionStatusResponse {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  watched: boolean;
  rating: number | null;
  ratingStars: number | null;
  outcome?: MediaActionWriteResponse['outcome'];
  providers: MediaActionProviderResult[];
  actions?: {
    watched: {
      available: boolean;
      reason?: 'no_provider' | 'not_mapped' | 'provider_error' | 'unsupported';
    };
    rating: {
      available: boolean;
      reason?: 'no_provider' | 'not_mapped' | 'provider_error' | 'unsupported';
    };
  };
}

export interface MediaActionWriteStatusResponse extends MediaActionStatusResponse {
  outcome: MediaActionWriteResponse['outcome'];
}

export function useMediaActionCapabilities() {
  return useSWR<MediaActionCapabilitiesResponse>(
    '/api/v1/media-actions/capabilities',
    {
      revalidateOnFocus: false,
    }
  );
}

interface UseMediaActionsOptions {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  enabled?: boolean;
  externalStatus?: MediaActionStatusResponse;
  deferStatusFetch?: boolean;
  batchRefsKey?: string | null;
  onStatusChange?: () => void;
}

export function useMediaActions({
  tmdbId,
  mediaType,
  enabled = true,
  externalStatus,
  deferStatusFetch = false,
  batchRefsKey = null,
  onStatusChange,
}: UseMediaActionsOptions) {
  const { data: capabilities } = useMediaActionCapabilities();
  const surfaceCapabilities =
    mediaType === 'movie' ? capabilities?.movie : capabilities?.tv;
  const globallyCanWatch = Boolean(surfaceCapabilities?.watched);
  const globallyCanRate = Boolean(surfaceCapabilities?.rating);
  const actionsConfigured =
    enabled &&
    (mediaType === 'movie' || mediaType === 'tv') &&
    (globallyCanWatch || globallyCanRate);

  const statusKey = actionsConfigured
    ? mediaActionStatusKey(mediaType, tmdbId)
    : null;

  const { data: swrData, isLoading: swrLoading } =
    useSWR<MediaActionStatusResponse>(statusKey, {
      isPaused: () => deferStatusFetch,
      revalidateOnFocus: false,
    });

  const [busy, setBusy] = useState(false);

  // Batch results seed the canonical SWR key. Prefer that shared value so a
  // mutation from any surface immediately supersedes an older batch payload.
  const data = swrData ?? externalStatus;
  const canWatch =
    globallyCanWatch && (data?.actions?.watched.available ?? true);
  const canRate = globallyCanRate && (data?.actions?.rating.available ?? true);
  const actionsEnabled = actionsConfigured && (!data || canWatch || canRate);
  const statusPending =
    actionsConfigured && !data && (deferStatusFetch || swrLoading);

  const applyNext = useCallback(
    async (next: MediaActionWriteStatusResponse) => {
      await invalidateMediaActionCaches({
        mediaType,
        tmdbId,
        next,
        batchRefsKey,
      });
      onStatusChange?.();
    },
    [batchRefsKey, mediaType, onStatusChange, tmdbId]
  );

  const toggleWatched = useCallback(async () => {
    if (busy || !actionsEnabled || !canWatch || statusPending || !data) {
      return false;
    }
    setBusy(true);
    try {
      const action = data.watched ? 'unwatched' : 'watched';
      const { data: next } = await axios.post<MediaActionWriteStatusResponse>(
        `/api/v1/media-actions/${mediaType}/${tmdbId}/${action}`,
        {}
      );
      if (!writeSucceeded(next)) {
        return false;
      }
      await applyNext(next);
      return next.outcome;
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  }, [
    actionsEnabled,
    applyNext,
    busy,
    canWatch,
    data,
    mediaType,
    statusPending,
    tmdbId,
  ]);

  const submitRating = useCallback(
    async (ratingStars: number) => {
      if (busy || !actionsEnabled || !canRate) {
        return false;
      }
      setBusy(true);
      try {
        const { data: next } = await axios.post<MediaActionWriteStatusResponse>(
          `/api/v1/media-actions/${mediaType}/${tmdbId}/rate`,
          { ratingStars }
        );
        if (!writeSucceeded(next)) {
          return false;
        }
        await applyNext(next);
        return next.outcome;
      } catch {
        return false;
      } finally {
        setBusy(false);
      }
    },
    [actionsEnabled, applyNext, busy, canRate, mediaType, tmdbId]
  );

  return {
    actionsEnabled,
    canWatch,
    canRate,
    data,
    statusPending,
    busy,
    toggleWatched,
    submitRating,
  };
}
