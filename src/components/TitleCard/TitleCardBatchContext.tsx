import type { MediaActionStatusResponse } from '@app/components/TitleCard/MediaActionControls';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import axios from 'axios';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import useSWR, { mutate as globalMutate } from 'swr';

export type TitleCardBatchRef = {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  title?: string;
  year?: number;
};

type StatusBatchResponse = {
  results: MediaActionStatusResponse[];
};

type TitleCardBatchContextValue = {
  getStatus: (
    mediaType: 'movie' | 'tv',
    tmdbId: number
  ) => MediaActionStatusResponse | undefined;
  /**
   * True only when this grid is actually owning status fetches.
   * Cards should fall back to per-item GETs when false.
   */
  active: boolean;
  /** Batch request in flight (unknown ≠ unwatched). */
  isLoading: boolean;
};

const TitleCardBatchContext = createContext<TitleCardBatchContextValue | null>(
  null
);

const itemKey = (mediaType: string, tmdbId: number) => `${mediaType}:${tmdbId}`;

const stableRefsKey = (refs: TitleCardBatchRef[]): string =>
  refs
    .map((r) => `${r.mediaType}:${r.tmdbId}`)
    .sort()
    .join(',');

export function useTitleCardBatch(): TitleCardBatchContextValue | null {
  return useContext(TitleCardBatchContext);
}

type TitleCardBatchProviderProps = {
  refs: TitleCardBatchRef[];
  children: ReactNode;
};

/**
 * One status-batch per ListView page of movie/tv cards.
 */
export function TitleCardBatchProvider({
  refs,
  children,
}: TitleCardBatchProviderProps) {
  const settings = useSettings();
  const { user } = useUser();
  const refsKey = useMemo(() => stableRefsKey(refs), [refs]);
  const uniqueRefs = useMemo(() => {
    const seen = new Set<string>();
    const out: TitleCardBatchRef[] = [];
    for (const ref of refs) {
      const key = itemKey(ref.mediaType, ref.tmdbId);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ref);
    }
    return out;
  }, [refs]);

  const mediaActionsLikely = Boolean(
    settings.currentSettings.traktConfigured &&
    settings.currentSettings.mediaActionsTraktEnabled !== false &&
    user
  );

  const traktLinkKey = mediaActionsLikely
    ? `/api/v1/user/${user?.id}/settings/linked-accounts/trakt`
    : null;
  const { data: traktLink, isLoading: traktLinkLoading } = useSWR<{
    connected: boolean;
  }>(traktLinkKey, {
    revalidateOnFocus: false,
  });

  const statusKey =
    mediaActionsLikely && traktLink?.connected && uniqueRefs.length
      ? ['/api/v1/media-actions/status-batch', refsKey]
      : null;

  const { data: statusData, isLoading: statusLoading } =
    useSWR<StatusBatchResponse>(
      statusKey,
      async () => {
        const { data } = await axios.post<StatusBatchResponse>(
          '/api/v1/media-actions/status-batch',
          {
            items: uniqueRefs.map((r) => ({
              mediaType: r.mediaType,
              tmdbId: r.tmdbId,
            })),
          }
        );
        return data;
      },
      { revalidateOnFocus: false, shouldRetryOnError: false }
    );

  const seededStatusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!statusData?.results?.length) return;
    const seedKey = refsKey;
    if (seededStatusRef.current === seedKey) return;
    seededStatusRef.current = seedKey;
    for (const result of statusData.results) {
      void globalMutate(
        `/api/v1/media-actions/${result.mediaType}/${result.tmdbId}/status`,
        result,
        { revalidate: false }
      );
    }
  }, [statusData, refsKey]);

  const statusMap = useMemo(() => {
    const map = new Map<string, MediaActionStatusResponse>();
    for (const result of statusData?.results ?? []) {
      map.set(itemKey(result.mediaType, result.tmdbId), result);
    }
    return map;
  }, [statusData]);

  const value = useMemo<TitleCardBatchContextValue>(
    () => ({
      // Only claim ownership once we know Trakt is linked and a batch is wired.
      active: Boolean(statusKey),
      isLoading: Boolean(
        traktLinkKey &&
        (traktLinkLoading || (statusKey && statusLoading && !statusData))
      ),
      getStatus: (mediaType, tmdbId) =>
        statusMap.get(itemKey(mediaType, tmdbId)),
    }),
    [
      statusKey,
      statusLoading,
      statusData,
      statusMap,
      traktLinkKey,
      traktLinkLoading,
    ]
  );

  return (
    <TitleCardBatchContext.Provider value={value}>
      {children}
    </TitleCardBatchContext.Provider>
  );
}
