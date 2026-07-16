import TraktAPI from '@server/api/trakt';
import type { TraktListEntry } from '@server/api/trakt/interfaces';

const DEFAULT_TTL_SECONDS = 7200;

export interface UserSyncSnapshot {
  watchedMovies: TraktListEntry[];
  watchedShows: TraktListEntry[];
  ratingsMovies: TraktListEntry[];
  ratingsShows: TraktListEntry[];
  fetchedAt: number;
}

export interface SyncItemPatch {
  watched?: boolean;
  /** Provider rating 1–10, or null to clear. */
  rating?: number | null;
}

interface PendingPatch {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  update: SyncItemPatch;
}

const cache = new Map<string, UserSyncSnapshot>();
const inflight = new Map<string, Promise<UserSyncSnapshot>>();
/** Local mutations applied on top of Trakt fetches until Trakt reflects them. */
const pendingPatches = new Map<string, PendingPatch[]>();

function cacheKey(userId: number): string {
  return String(userId);
}

function emptySnapshot(): UserSyncSnapshot {
  return {
    watchedMovies: [],
    watchedShows: [],
    ratingsMovies: [],
    ratingsShows: [],
    fetchedAt: Date.now() / 1000,
  };
}

export function invalidateUserSyncCache(userId: number): void {
  cache.delete(cacheKey(userId));
}

export function clearSyncCache(): void {
  cache.clear();
  inflight.clear();
  pendingPatches.clear();
}

/** Test helper — seed or inspect a user's snapshot. */
export function seedUserSyncCache(
  userId: number,
  snapshot: UserSyncSnapshot
): void {
  cache.set(cacheKey(userId), snapshot);
}

export function getUserSyncSnapshot(
  userId: number
): UserSyncSnapshot | undefined {
  return cache.get(cacheKey(userId));
}

function isExpired(snapshot: UserSyncSnapshot, ttlSeconds: number): boolean {
  return Date.now() / 1000 - snapshot.fetchedAt > ttlSeconds;
}

function itemKey(mediaType: 'movie' | 'tv'): 'movie' | 'show' {
  return mediaType === 'movie' ? 'movie' : 'show';
}

function entryMatchesTmdb(
  entry: TraktListEntry,
  key: 'movie' | 'show',
  tmdbId: number
): boolean {
  const ids = entry?.[key]?.ids;
  return ids?.tmdb != null && Number(ids.tmdb) === Number(tmdbId);
}

function removeByTmdb(
  list: TraktListEntry[],
  key: 'movie' | 'show',
  tmdbId: number
): TraktListEntry[] {
  return list.filter((entry) => !entryMatchesTmdb(entry, key, tmdbId));
}

function upsertWatched(
  list: TraktListEntry[],
  key: 'movie' | 'show',
  tmdbId: number
): TraktListEntry[] {
  if (list.some((entry) => entryMatchesTmdb(entry, key, tmdbId))) {
    return list;
  }
  return [...list, { [key]: { ids: { tmdb: tmdbId } } }];
}

function upsertRating(
  list: TraktListEntry[],
  key: 'movie' | 'show',
  tmdbId: number,
  rating: number
): TraktListEntry[] {
  const next = removeByTmdb(list, key, tmdbId);
  next.push({ [key]: { ids: { tmdb: tmdbId } }, rating });
  return next;
}

function applyPatchToSnapshot(
  snapshot: UserSyncSnapshot,
  mediaType: 'movie' | 'tv',
  tmdbId: number,
  update: SyncItemPatch
): void {
  const key = itemKey(mediaType);
  const watchedList =
    mediaType === 'movie' ? snapshot.watchedMovies : snapshot.watchedShows;
  const ratingsList =
    mediaType === 'movie' ? snapshot.ratingsMovies : snapshot.ratingsShows;

  let nextWatched = watchedList;
  let nextRatings = ratingsList;

  if (update.watched === true) {
    nextWatched = upsertWatched(watchedList, key, tmdbId);
  } else if (update.watched === false) {
    nextWatched = removeByTmdb(watchedList, key, tmdbId);
  }

  if (update.rating === null) {
    nextRatings = removeByTmdb(ratingsList, key, tmdbId);
  } else if (typeof update.rating === 'number') {
    nextRatings = upsertRating(ratingsList, key, tmdbId, update.rating);
  }

  if (mediaType === 'movie') {
    snapshot.watchedMovies = nextWatched;
    snapshot.ratingsMovies = nextRatings;
  } else {
    snapshot.watchedShows = nextWatched;
    snapshot.ratingsShows = nextRatings;
  }
}

function coalescePending(patches: PendingPatch[]): PendingPatch[] {
  const byKey = new Map<string, PendingPatch>();
  for (const patch of patches) {
    const key = `${patch.mediaType}:${patch.tmdbId}`;
    const prev = byKey.get(key);
    byKey.set(key, {
      mediaType: patch.mediaType,
      tmdbId: patch.tmdbId,
      update: { ...prev?.update, ...patch.update },
    });
  }
  return [...byKey.values()];
}

function patchIsReflected(
  snapshot: UserSyncSnapshot,
  patch: PendingPatch
): boolean {
  const status = lookupItemStatus(snapshot, patch.mediaType, patch.tmdbId);
  const { update } = patch;

  if (update.watched === true && !status.watched) {
    return false;
  }
  if (update.watched === false && status.watched) {
    return false;
  }
  if (update.rating === null && status.rating != null) {
    return false;
  }
  if (typeof update.rating === 'number' && status.rating !== update.rating) {
    return false;
  }
  return true;
}

function applyPendingPatches(
  userKey: string,
  snapshot: UserSyncSnapshot
): void {
  const pending = pendingPatches.get(userKey) ?? [];
  if (!pending.length) {
    return;
  }

  const remaining: PendingPatch[] = [];
  for (const patch of pending) {
    if (!patchIsReflected(snapshot, patch)) {
      remaining.push(patch);
      applyPatchToSnapshot(
        snapshot,
        patch.mediaType,
        patch.tmdbId,
        patch.update
      );
    }
  }

  if (remaining.length) {
    pendingPatches.set(userKey, remaining);
  } else {
    pendingPatches.delete(userKey);
  }
}

/**
 * Surgically update one item in the per-user sync snapshot.
 * Seeds an empty snapshot when none exists so mark-watched is not lost.
 * Pending patches survive concurrent Trakt re-fetches until Trakt matches.
 */
export function patchUserSyncItem(
  userId: number,
  mediaType: 'movie' | 'tv',
  tmdbId: number,
  update: SyncItemPatch
): void {
  const key = cacheKey(userId);
  let snapshot = cache.get(key);
  if (!snapshot) {
    snapshot = emptySnapshot();
    cache.set(key, snapshot);
  }

  applyPatchToSnapshot(snapshot, mediaType, tmdbId, update);

  const pending = pendingPatches.get(key) ?? [];
  pending.push({ mediaType, tmdbId, update });
  pendingPatches.set(key, coalescePending(pending));
}

export function lookupItemStatus(
  snapshot: UserSyncSnapshot,
  mediaType: 'movie' | 'tv',
  tmdbId: number
): { watched: boolean; rating: number | null } {
  if (mediaType === 'movie') {
    return {
      watched: TraktAPI.payloadContainsTmdb(
        snapshot.watchedMovies,
        'movie',
        tmdbId
      ),
      rating: TraktAPI.findRatingForTmdb(
        snapshot.ratingsMovies,
        'movie',
        tmdbId
      ),
    };
  }
  return {
    watched: TraktAPI.payloadContainsTmdb(
      snapshot.watchedShows,
      'show',
      tmdbId
    ),
    rating: TraktAPI.findRatingForTmdb(snapshot.ratingsShows, 'show', tmdbId),
  };
}

export async function warmUserSyncCache(
  client: TraktAPI,
  userId: number,
  ttlSeconds = DEFAULT_TTL_SECONDS
): Promise<UserSyncSnapshot> {
  const key = cacheKey(userId);
  const existing = cache.get(key);
  if (existing && !isExpired(existing, ttlSeconds)) {
    applyPendingPatches(key, existing);
    return existing;
  }

  const pending = inflight.get(key);
  if (pending) {
    return pending;
  }

  const load = (async (): Promise<UserSyncSnapshot> => {
    const cached = cache.get(key);
    if (cached && !isExpired(cached, ttlSeconds)) {
      applyPendingPatches(key, cached);
      return cached;
    }

    const [watchedMovies, watchedShows, ratingsMovies, ratingsShows] =
      await Promise.all([
        client.getSyncWatched('movie'),
        client.getSyncWatched('tv'),
        client.getSyncRatings('movie'),
        client.getSyncRatings('tv'),
      ]);

    const snapshot: UserSyncSnapshot = {
      watchedMovies: watchedMovies || [],
      watchedShows: watchedShows || [],
      ratingsMovies: ratingsMovies || [],
      ratingsShows: ratingsShows || [],
      fetchedAt: Date.now() / 1000,
    };

    // Re-apply local mark/unmark/rate that Trakt has not caught up with yet,
    // and avoid clobbering patches applied while this fetch was in flight.
    applyPendingPatches(key, snapshot);
    cache.set(key, snapshot);
    return snapshot;
  })();

  inflight.set(key, load);
  try {
    return await load;
  } finally {
    inflight.delete(key);
  }
}

export async function getCachedItemStatus(
  client: TraktAPI,
  userId: number,
  mediaType: 'movie' | 'tv',
  tmdbId: number
): Promise<{ watched: boolean; rating: number | null }> {
  const snapshot = await warmUserSyncCache(client, userId);
  return lookupItemStatus(snapshot, mediaType, tmdbId);
}
