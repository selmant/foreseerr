import type TraktAPI from '@server/api/trakt';
import type { TraktMediaItem } from '@server/api/trakt/interfaces';
import {
  warmUserSyncCache,
  type UserSyncSnapshot,
} from '@server/lib/mediaActions/syncCache';

export interface WatchedIdSets {
  movie: Set<number>;
  tv: Set<number>;
}

export function buildWatchedIdSets(snapshot: UserSyncSnapshot): WatchedIdSets {
  const movie = new Set<number>();
  const tv = new Set<number>();

  for (const entry of snapshot.watchedMovies) {
    const id = entry?.movie?.ids?.tmdb;
    if (id != null) {
      movie.add(Number(id));
    }
  }
  for (const entry of snapshot.watchedShows) {
    const id = entry?.show?.ids?.tmdb;
    if (id != null) {
      tv.add(Number(id));
    }
  }

  return { movie, tv };
}

export function isWatchedInSets(
  sets: WatchedIdSets,
  mediaType: 'movie' | 'tv',
  tmdbId: number
): boolean {
  const bucket = mediaType === 'movie' ? sets.movie : sets.tv;
  return bucket.has(Number(tmdbId));
}

export function filterWatchedTraktItems(
  items: TraktMediaItem[],
  sets: WatchedIdSets
): TraktMediaItem[] {
  return items.filter(
    (item) => !isWatchedInSets(sets, item.mediaType, item.tmdbId)
  );
}

export function filterWatchedMixedBrowseResults<
  T extends { mediaType?: string; id?: number },
>(results: T[], sets: WatchedIdSets): T[] {
  return results.filter((item) => {
    if (item.mediaType !== 'movie' && item.mediaType !== 'tv') {
      return true;
    }
    if (item.id == null) {
      return true;
    }
    return !isWatchedInSets(sets, item.mediaType as 'movie' | 'tv', item.id);
  });
}

export async function loadWatchedIdSets(
  userId: number,
  trakt: TraktAPI
): Promise<WatchedIdSets> {
  const snapshot = await warmUserSyncCache(trakt, userId);
  return buildWatchedIdSets(snapshot);
}
