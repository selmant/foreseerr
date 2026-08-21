import type { JellyfinLibraryItemExtended } from '@server/api/jellyfin';
import type TraktAPI from '@server/api/trakt';
import type { TraktMediaItem } from '@server/api/trakt/interfaces';
import {
  createAnilistUserClient,
  getUserAnilistSettings,
  isAnilistUnavailableError,
} from '@server/lib/anilist';
import { createUserJellyfinClient } from '@server/lib/library';
import {
  isAnilistWatchedStatus,
  warmUserAnilistSyncCache,
} from '@server/lib/mediaActions/anilistSyncCache';
import {
  warmUserSyncCache,
  type UserSyncSnapshot,
} from '@server/lib/mediaActions/syncCache';
import {
  createTraktUserClient,
  isTraktUnavailableError,
} from '@server/lib/trakt';
import logger from '@server/logger';

export interface WatchedIdSets {
  movie: Set<number>;
  tv: Set<number>;
}

export function emptyWatchedIdSets(): WatchedIdSets {
  return { movie: new Set(), tv: new Set() };
}

export function unionWatchedIdSets(...sets: WatchedIdSets[]): WatchedIdSets {
  const movie = new Set<number>();
  const tv = new Set<number>();
  for (const set of sets) {
    for (const id of set.movie) {
      movie.add(id);
    }
    for (const id of set.tv) {
      tv.add(id);
    }
  }
  return { movie, tv };
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

function tmdbIdFromJellyfinItem(
  item: JellyfinLibraryItemExtended
): number | undefined {
  const raw = item.ProviderIds?.Tmdb ?? item.ProviderIds?.TheMovieDb;
  if (!raw) {
    return undefined;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function buildWatchedIdSetsFromJellyfinItems(
  items: JellyfinLibraryItemExtended[]
): WatchedIdSets {
  const sets = emptyWatchedIdSets();
  for (const item of items) {
    const tmdbId = tmdbIdFromJellyfinItem(item);
    if (!tmdbId) {
      continue;
    }
    if (item.Type === 'Movie') {
      sets.movie.add(tmdbId);
    } else if (item.Type === 'Series') {
      sets.tv.add(tmdbId);
    }
  }
  return sets;
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
  return items.filter((item) => {
    if (!item.tmdbId || item.tmdbId <= 0) {
      return true;
    }
    return !isWatchedInSets(sets, item.mediaType, item.tmdbId);
  });
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

async function loadTraktWatchedIdSets(
  userId: number,
  trakt?: TraktAPI
): Promise<WatchedIdSets> {
  try {
    const client = trakt ?? (await createTraktUserClient(userId));
    return await loadWatchedIdSets(userId, client);
  } catch (e) {
    if (!isTraktUnavailableError(e)) {
      logger.debug('Skipping Trakt watched-title filtering', {
        label: 'API',
        errorMessage: e instanceof Error ? e.message : 'unknown error',
      });
    }
    return emptyWatchedIdSets();
  }
}

export async function loadJellyfinWatchedIdSets(
  userId: number
): Promise<WatchedIdSets> {
  try {
    const linked = await createUserJellyfinClient(userId);
    if (!linked.ok) {
      return emptyWatchedIdSets();
    }
    const items = await linked.client.getPlayedLibraryItems();
    return buildWatchedIdSetsFromJellyfinItems(items);
  } catch (e) {
    logger.debug('Skipping Jellyfin watched-title filtering', {
      label: 'API',
      errorMessage: e instanceof Error ? e.message : 'unknown error',
    });
    return emptyWatchedIdSets();
  }
}

export async function loadAnilistWatchedIdSets(
  userId: number
): Promise<WatchedIdSets> {
  try {
    const client = await createAnilistUserClient(userId);
    const settings = await getUserAnilistSettings(userId);
    const anilistUserId = Number(settings?.anilistUserId);
    if (!Number.isFinite(anilistUserId) || anilistUserId <= 0) {
      return emptyWatchedIdSets();
    }
    const snapshot = await warmUserAnilistSyncCache(
      client,
      userId,
      anilistUserId
    );
    const sets = emptyWatchedIdSets();
    for (const entry of snapshot.entries) {
      if (!isAnilistWatchedStatus(entry.status)) {
        continue;
      }
      if (entry.mediaType === 'movie') {
        sets.movie.add(entry.tmdbId);
      } else {
        sets.tv.add(entry.tmdbId);
      }
    }
    return sets;
  } catch (e) {
    if (!isAnilistUnavailableError(e)) {
      logger.debug('Skipping AniList watched-title filtering', {
        label: 'API',
        errorMessage: e instanceof Error ? e.message : 'unknown error',
      });
    }
    return emptyWatchedIdSets();
  }
}

export async function loadCombinedWatchedIdSets(
  userId: number,
  trakt?: TraktAPI
): Promise<WatchedIdSets> {
  const [traktSets, jellyfinSets, anilistSets] = await Promise.all([
    loadTraktWatchedIdSets(userId, trakt),
    loadJellyfinWatchedIdSets(userId),
    loadAnilistWatchedIdSets(userId),
  ]);
  return unionWatchedIdSets(traktSets, jellyfinSets, anilistSets);
}
