import type { MediaActionStatusResponse } from '@app/hooks/useMediaActions';
import { mutate as globalMutate } from 'swr';

type Revalidator = () => void | Promise<void>;

const hideWatchedRevalidators = new Set<Revalidator>();
const libraryShelfRevalidators = new Set<Revalidator>();

export function mediaActionStatusKey(
  mediaType: 'movie' | 'tv',
  tmdbId: number
): string {
  return `/api/v1/media-actions/${mediaType}/${tmdbId}/status`;
}

export function mediaActionBatchKey(refsKey: string): [string, string] {
  return ['/api/v1/media-actions/status-batch', refsKey];
}

function isMediaActionBatchKey(key: unknown): key is [string, string] {
  return (
    Array.isArray(key) &&
    key[0] === '/api/v1/media-actions/status-batch' &&
    typeof key[1] === 'string'
  );
}

export function mediaActionSeasonStatusKey(
  tvId: number,
  seasonNumber: number
): string {
  return `/api/v1/media-actions/tv/${tvId}/seasons/${seasonNumber}/episodes/status`;
}

export function registerHideWatchedRevalidator(
  revalidator: Revalidator
): () => void {
  hideWatchedRevalidators.add(revalidator);
  return () => {
    hideWatchedRevalidators.delete(revalidator);
  };
}

export function registerLibraryShelfRevalidator(
  revalidator: Revalidator
): () => void {
  libraryShelfRevalidators.add(revalidator);
  return () => {
    libraryShelfRevalidators.delete(revalidator);
  };
}

async function runRevalidators(revalidators: Set<Revalidator>) {
  await Promise.all(
    [...revalidators].map(async (revalidator) => {
      await revalidator();
    })
  );
}

export async function invalidateMediaActionStatus(
  mediaType: 'movie' | 'tv',
  tmdbId: number,
  next?: MediaActionStatusResponse
) {
  const key = mediaActionStatusKey(mediaType, tmdbId);
  if (next) {
    await globalMutate(key, next, { revalidate: false });
    return;
  }
  await globalMutate(key);
}

export async function invalidateMediaActionCaches(options: {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  next?: MediaActionStatusResponse;
  batchRefsKey?: string | null;
  tvId?: number;
  seasonNumber?: number;
}) {
  await invalidateMediaActionStatus(
    options.mediaType,
    options.tmdbId,
    options.next
  );
  if (options.next?.outcome === 'partial') {
    await invalidateMediaActionStatus(options.mediaType, options.tmdbId);
  }

  // A title may be visible in several mounted grids, and mutations may start
  // from a detail page that has no knowledge of those grids' refs keys.
  // Revalidate every active media-action batch so cards and details converge.
  await globalMutate(isMediaActionBatchKey);

  if (options.tvId != null && options.seasonNumber != null) {
    await globalMutate(
      mediaActionSeasonStatusKey(options.tvId, options.seasonNumber)
    );
  }

  await runRevalidators(hideWatchedRevalidators);
  await runRevalidators(libraryShelfRevalidators);
}
