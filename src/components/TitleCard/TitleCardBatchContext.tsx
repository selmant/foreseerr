import type { MediaActionStatusResponse } from '@app/hooks/useMediaActions';
import { useMediaActionCapabilities } from '@app/hooks/useMediaActions';
import { useUser } from '@app/hooks/useUser';
import {
  mediaActionBatchKey,
  mediaActionStatusKey,
} from '@app/utils/mediaActionInvalidation';
import axios from 'axios';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import useSWR, { mutate as globalMutate } from 'swr';

export type { MediaActionStatusResponse };

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
  const { user } = useUser();
  const { data: capabilities, isLoading: capabilitiesLoading } =
    useMediaActionCapabilities();
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

  const titleActionsAvailable = Boolean(
    user &&
    uniqueRefs.length &&
    uniqueRefs.some((ref) => {
      const surface =
        ref.mediaType === 'movie' ? capabilities?.movie : capabilities?.tv;
      return surface?.watched || surface?.rating;
    })
  );

  const statusKey =
    titleActionsAvailable && uniqueRefs.length
      ? mediaActionBatchKey(refsKey)
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

  useEffect(() => {
    if (!statusData?.results?.length) return;
    for (const result of statusData.results) {
      void globalMutate(
        mediaActionStatusKey(result.mediaType, result.tmdbId),
        result,
        { revalidate: false }
      );
    }
  }, [statusData]);

  const statusMap = useMemo(() => {
    const map = new Map<string, MediaActionStatusResponse>();
    for (const result of statusData?.results ?? []) {
      map.set(itemKey(result.mediaType, result.tmdbId), result);
    }
    return map;
  }, [statusData]);

  const value = useMemo<TitleCardBatchContextValue>(
    () => ({
      active: Boolean(statusKey),
      isLoading: Boolean(
        titleActionsAvailable &&
        (capabilitiesLoading || (statusKey && statusLoading && !statusData))
      ),
      getStatus: (mediaType, tmdbId) =>
        statusMap.get(itemKey(mediaType, tmdbId)),
    }),
    [
      capabilitiesLoading,
      statusData,
      statusKey,
      statusLoading,
      statusMap,
      titleActionsAvailable,
    ]
  );

  return (
    <TitleCardBatchContext.Provider value={value}>
      {children}
    </TitleCardBatchContext.Provider>
  );
}
