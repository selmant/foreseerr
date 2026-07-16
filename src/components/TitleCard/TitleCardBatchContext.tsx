import type { MediaActionStatusResponse } from '@app/components/TitleCard/MediaActionControls';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import type { RatingResponse } from '@server/api/ratings';
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

type RatingsBatchResponse = {
  results: {
    mediaType: 'movie' | 'tv';
    tmdbId: number;
    ratings: RatingResponse | null;
  }[];
};

type StatusBatchResponse = {
  results: MediaActionStatusResponse[];
};

type TitleCardBatchContextValue = {
  getRatings: (
    mediaType: 'movie' | 'tv',
    tmdbId: number
  ) => RatingResponse | null | undefined;
  getStatus: (
    mediaType: 'movie' | 'tv',
    tmdbId: number
  ) => MediaActionStatusResponse | undefined;
  /** True while this grid owns batching (skip per-card GETs). */
  active: boolean;
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
 * One status-batch + one ratings-batch per ListView page of movie/tv cards.
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
  }, [refs, refsKey]);

  const mdblistConfigured = Boolean(settings.currentSettings.mdblistConfigured);
  const mediaActionsLikely = Boolean(
    settings.currentSettings.traktConfigured &&
    settings.currentSettings.mediaActionsTraktEnabled !== false &&
    user
  );

  const ratingsKey =
    mdblistConfigured && uniqueRefs.length
      ? ['/api/v1/ratings/batch', refsKey]
      : null;

  const { data: ratingsData } = useSWR<RatingsBatchResponse>(
    ratingsKey,
    async () => {
      const { data } = await axios.post<RatingsBatchResponse>(
        '/api/v1/ratings/batch',
        {
          items: uniqueRefs.map((r) => ({
            mediaType: r.mediaType,
            tmdbId: r.tmdbId,
            title: r.title,
            year: r.year,
          })),
        }
      );
      return data;
    },
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );

  const traktLinkKey = mediaActionsLikely
    ? `/api/v1/user/${user?.id}/settings/linked-accounts/trakt`
    : null;
  const { data: traktLink } = useSWR<{ connected: boolean }>(traktLinkKey, {
    revalidateOnFocus: false,
  });

  const statusKey =
    mediaActionsLikely && traktLink?.connected && uniqueRefs.length
      ? ['/api/v1/media-actions/status-batch', refsKey]
      : null;

  const { data: statusData } = useSWR<StatusBatchResponse>(
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

  const ratingsMap = useMemo(() => {
    const map = new Map<string, RatingResponse | null>();
    for (const result of ratingsData?.results ?? []) {
      map.set(itemKey(result.mediaType, result.tmdbId), result.ratings);
    }
    return map;
  }, [ratingsData]);

  const statusMap = useMemo(() => {
    const map = new Map<string, MediaActionStatusResponse>();
    for (const result of statusData?.results ?? []) {
      map.set(itemKey(result.mediaType, result.tmdbId), result);
    }
    return map;
  }, [statusData]);

  const value = useMemo<TitleCardBatchContextValue>(
    () => ({
      active: true,
      getRatings: (mediaType, tmdbId) =>
        ratingsMap.has(itemKey(mediaType, tmdbId))
          ? ratingsMap.get(itemKey(mediaType, tmdbId))
          : undefined,
      getStatus: (mediaType, tmdbId) =>
        statusMap.get(itemKey(mediaType, tmdbId)),
    }),
    [ratingsMap, statusMap]
  );

  return (
    <TitleCardBatchContext.Provider value={value}>
      {children}
    </TitleCardBatchContext.Provider>
  );
}
