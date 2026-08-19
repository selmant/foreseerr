import type AnilistAPI from '@server/api/anilist';
import type { AnilistMediaListStatus } from '@server/api/anilist/interfaces';
import anilistIdMapping from '@server/lib/anilist/mapping';

const DEFAULT_TTL_SECONDS = 7200;

export interface AnilistSyncEntry {
  anilistId: number;
  listEntryId: number | null;
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  status: AnilistMediaListStatus | null;
  /** Provider-native 1–10 score. */
  rating: number | null;
  /** Watched episode watermark for TV/anime list entries. */
  progress?: number | null;
  episodeCount?: number | null;
}

export interface AnilistUserSnapshot {
  entries: AnilistSyncEntry[];
  fetchedAt: number;
}

export interface AnilistSyncItemPatch {
  watched?: boolean;
  rating?: number | null;
  listEntryId?: number | null;
  status?: AnilistMediaListStatus | null;
  anilistId?: number;
  progress?: number | null;
  episodeCount?: number | null;
}

interface PendingPatch {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  update: AnilistSyncItemPatch;
}

const cache = new Map<string, AnilistUserSnapshot>();
const inflight = new Map<string, Promise<AnilistUserSnapshot>>();
const pendingPatches = new Map<string, PendingPatch[]>();
let globalCacheGeneration = 0;
const userCacheGenerations = new Map<string, number>();

function cacheKey(userId: number): string {
  return String(userId);
}

function bumpUserCacheGeneration(userId: number): number {
  const key = cacheKey(userId);
  const next = (userCacheGenerations.get(key) ?? 0) + 1;
  userCacheGenerations.set(key, next);
  return next;
}

function isCacheGenerationStale(
  userId: number,
  userGenerationAtStart: number,
  globalGenerationAtStart: number
): boolean {
  const key = cacheKey(userId);
  return (
    globalCacheGeneration !== globalGenerationAtStart ||
    (userCacheGenerations.get(key) ?? 0) !== userGenerationAtStart
  );
}

function emptySnapshot(): AnilistUserSnapshot {
  return { entries: [], fetchedAt: Date.now() / 1000 };
}

export function invalidateUserAnilistSyncCache(userId: number): void {
  bumpUserCacheGeneration(userId);
  const key = cacheKey(userId);
  cache.delete(key);
  inflight.delete(key);
  pendingPatches.delete(key);
}

export function clearAnilistSyncCache(): void {
  globalCacheGeneration += 1;
  cache.clear();
  inflight.clear();
  pendingPatches.clear();
}

export function seedUserAnilistSyncCache(
  userId: number,
  snapshot: AnilistUserSnapshot
): void {
  cache.set(cacheKey(userId), snapshot);
}

export function getUserAnilistSnapshot(
  userId: number
): AnilistUserSnapshot | undefined {
  return cache.get(cacheKey(userId));
}

function isExpired(snapshot: AnilistUserSnapshot, ttlSeconds: number): boolean {
  return Date.now() / 1000 - snapshot.fetchedAt > ttlSeconds;
}

function entryKey(mediaType: 'movie' | 'tv', tmdbId: number): string {
  return `${mediaType}:${Number(tmdbId)}`;
}

export function isAnilistWatchedStatus(
  status: AnilistMediaListStatus | null | undefined
): boolean {
  return status === 'COMPLETED' || status === 'REPEATING';
}

export function scoreRawToProvider(
  scoreRaw: number | null | undefined
): number | null {
  if (scoreRaw == null || scoreRaw <= 0) {
    return null;
  }
  return Math.max(1, Math.min(10, Math.round(scoreRaw / 10)));
}

export function providerRatingToScoreRaw(rating: number): number {
  return Math.max(10, Math.min(100, Math.round(rating * 10)));
}

function applyPatchToEntries(
  entries: AnilistSyncEntry[],
  patch: PendingPatch
): AnilistSyncEntry[] {
  const key = entryKey(patch.mediaType, patch.tmdbId);
  const index = entries.findIndex(
    (entry) => entryKey(entry.mediaType, entry.tmdbId) === key
  );
  const current = index >= 0 ? entries[index] : null;
  const watched =
    patch.update.watched ??
    (current ? isAnilistWatchedStatus(current.status) : false);
  const status =
    patch.update.status ??
    (patch.update.watched === true
      ? 'COMPLETED'
      : patch.update.watched === false
        ? null
        : (current?.status ?? null));
  const rating =
    patch.update.rating !== undefined
      ? patch.update.rating
      : (current?.rating ?? null);
  const anilistId = patch.update.anilistId ?? current?.anilistId;
  if (!anilistId) {
    return entries;
  }

  const nextEntry: AnilistSyncEntry = {
    anilistId,
    listEntryId:
      patch.update.listEntryId !== undefined
        ? patch.update.listEntryId
        : (current?.listEntryId ?? null),
    tmdbId: patch.tmdbId,
    mediaType: patch.mediaType,
    status: watched ? (status ?? 'COMPLETED') : status,
    rating,
    progress:
      patch.update.progress !== undefined
        ? patch.update.progress
        : (current?.progress ?? null),
    episodeCount:
      patch.update.episodeCount !== undefined
        ? patch.update.episodeCount
        : (current?.episodeCount ?? null),
  };

  if (patch.update.watched === false && patch.update.listEntryId === null) {
    return entries.filter((_, i) => i !== index);
  }

  if (index >= 0) {
    const copy = [...entries];
    copy[index] = nextEntry;
    return copy;
  }
  return [...entries, nextEntry];
}

function applyPendingPatches(
  snapshot: AnilistUserSnapshot,
  userId: number
): AnilistUserSnapshot {
  const patches = pendingPatches.get(cacheKey(userId)) ?? [];
  if (patches.length === 0) {
    return snapshot;
  }
  let entries = snapshot.entries;
  for (const patch of patches) {
    entries = applyPatchToEntries(entries, patch);
  }
  return { ...snapshot, entries };
}

export function patchUserAnilistSyncItem(
  userId: number,
  mediaType: 'movie' | 'tv',
  tmdbId: number,
  update: AnilistSyncItemPatch
): void {
  const key = cacheKey(userId);
  const existing = pendingPatches.get(key) ?? [];
  pendingPatches.set(key, [...existing, { mediaType, tmdbId, update }]);
  const snapshot = cache.get(key);
  if (snapshot) {
    cache.set(key, applyPendingPatches(snapshot, userId));
  }
}

export function lookupAnilistItemStatus(
  snapshot: AnilistUserSnapshot,
  mediaType: 'movie' | 'tv',
  tmdbId: number
): { watched: boolean; rating: number | null; entry: AnilistSyncEntry | null } {
  const entry =
    snapshot.entries.find(
      (item) =>
        item.mediaType === mediaType && Number(item.tmdbId) === Number(tmdbId)
    ) ?? null;
  return {
    watched: isAnilistWatchedStatus(entry?.status),
    rating: entry?.rating ?? null,
    entry,
  };
}

async function fetchSnapshot(
  client: AnilistAPI,
  userId: number,
  anilistUserId: number
): Promise<AnilistUserSnapshot> {
  await anilistIdMapping.sync();
  const collection = await client.getMediaListCollection(anilistUserId);
  const seen = new Set<string>();
  const entries: AnilistSyncEntry[] = [];

  for (const list of collection.lists) {
    for (const listEntry of list.entries ?? []) {
      const anilistId = listEntry.media?.id;
      if (!anilistId) {
        continue;
      }
      const mapped = anilistIdMapping.getFromAnilistId(anilistId);
      if (!mapped) {
        continue;
      }
      const key = entryKey(mapped.mediaType, mapped.tmdbId);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      entries.push({
        anilistId,
        listEntryId: listEntry.id,
        tmdbId: mapped.tmdbId,
        mediaType: mapped.mediaType,
        status: listEntry.status ?? list.status ?? null,
        rating:
          scoreRawToProvider(listEntry.scoreRaw) ??
          (listEntry.score != null && listEntry.score > 0
            ? Math.max(1, Math.min(10, Math.round(listEntry.score)))
            : null),
        progress: listEntry.progress ?? 0,
        episodeCount: listEntry.media?.episodes ?? null,
      });
    }
  }

  return { entries, fetchedAt: Date.now() / 1000 };
}

export async function warmUserAnilistSyncCache(
  client: AnilistAPI,
  userId: number,
  anilistUserId: number,
  ttlSeconds = DEFAULT_TTL_SECONDS
): Promise<AnilistUserSnapshot> {
  const key = cacheKey(userId);
  const cached = cache.get(key);
  if (cached && !isExpired(cached, ttlSeconds)) {
    return applyPendingPatches(cached, userId);
  }

  const existingInflight = inflight.get(key);
  if (existingInflight) {
    const snapshot = await existingInflight;
    return applyPendingPatches(snapshot, userId);
  }

  const userGenerationAtStart = userCacheGenerations.get(key) ?? 0;
  const globalGenerationAtStart = globalCacheGeneration;
  const pending = fetchSnapshot(client, userId, anilistUserId)
    .then((snapshot) => {
      if (
        isCacheGenerationStale(
          userId,
          userGenerationAtStart,
          globalGenerationAtStart
        )
      ) {
        return cache.get(key) ?? emptySnapshot();
      }
      cache.set(key, snapshot);
      pendingPatches.delete(key);
      return snapshot;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, pending);
  const snapshot = await pending;
  return applyPendingPatches(snapshot, userId);
}
