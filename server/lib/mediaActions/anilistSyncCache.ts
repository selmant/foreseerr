import type AnilistAPI from '@server/api/anilist';
import type { AnilistMediaListStatus } from '@server/api/anilist/interfaces';
import anilistIdMapping from '@server/lib/anilist/mapping';
import { UserSnapshotCache } from './userSnapshotCache';

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

const snapshots = new UserSnapshotCache<AnilistUserSnapshot>();
const pendingPatches = new Map<string, PendingPatch[]>();

function cacheKey(userId: number): string {
  return snapshots.key(userId);
}

function emptySnapshot(): AnilistUserSnapshot {
  return { entries: [], fetchedAt: Date.now() / 1000 };
}

export function invalidateUserAnilistSyncCache(userId: number): void {
  snapshots.invalidateUser(userId);
  const key = cacheKey(userId);
  pendingPatches.delete(key);
}

export function clearAnilistSyncCache(): void {
  snapshots.clear();
  pendingPatches.clear();
}

export function seedUserAnilistSyncCache(
  userId: number,
  snapshot: AnilistUserSnapshot
): void {
  snapshots.set(userId, snapshot);
}

export function getUserAnilistSnapshot(
  userId: number
): AnilistUserSnapshot | undefined {
  return snapshots.get(userId);
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
  const index = entries.findIndex((entry) =>
    patch.update.anilistId != null
      ? entry.anilistId === patch.update.anilistId
      : entryKey(entry.mediaType, entry.tmdbId) === key
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
  const key = cacheKey(userId);
  const patches = pendingPatches.get(key) ?? [];
  if (patches.length === 0) {
    return snapshot;
  }

  const remaining: PendingPatch[] = [];
  let entries = snapshot.entries;
  for (const patch of patches) {
    if (!patchIsReflected(entries, patch)) {
      remaining.push(patch);
      entries = applyPatchToEntries(entries, patch);
    }
  }
  if (remaining.length) {
    pendingPatches.set(key, remaining);
  } else {
    pendingPatches.delete(key);
  }
  return { ...snapshot, entries };
}

function patchIsReflected(
  entries: AnilistSyncEntry[],
  patch: PendingPatch
): boolean {
  const entry = entries.find((item) =>
    patch.update.anilistId != null
      ? item.anilistId === patch.update.anilistId
      : entryKey(item.mediaType, item.tmdbId) ===
        entryKey(patch.mediaType, patch.tmdbId)
  );
  const update = patch.update;
  if (
    update.watched !== undefined &&
    isAnilistWatchedStatus(entry?.status) !== update.watched
  ) {
    return false;
  }
  if (
    update.rating !== undefined &&
    (entry?.rating ?? null) !== update.rating
  ) {
    return false;
  }
  if (
    update.listEntryId !== undefined &&
    (entry?.listEntryId ?? null) !== update.listEntryId
  ) {
    return false;
  }
  if (
    update.status !== undefined &&
    (entry?.status ?? null) !== update.status
  ) {
    return false;
  }
  if (
    update.progress !== undefined &&
    (entry?.progress ?? null) !== update.progress
  ) {
    return false;
  }
  if (
    update.episodeCount !== undefined &&
    (entry?.episodeCount ?? null) !== update.episodeCount
  ) {
    return false;
  }
  return true;
}

function coalescePending(patches: PendingPatch[]): PendingPatch[] {
  const byKey = new Map<string, PendingPatch>();
  for (const patch of patches) {
    const key = entryKey(patch.mediaType, patch.tmdbId);
    const previous = byKey.get(key);
    byKey.set(key, {
      mediaType: patch.mediaType,
      tmdbId: patch.tmdbId,
      update: { ...previous?.update, ...patch.update },
    });
  }
  return [...byKey.values()];
}

export function patchUserAnilistSyncItem(
  userId: number,
  mediaType: 'movie' | 'tv',
  tmdbId: number,
  update: AnilistSyncItemPatch
): void {
  const key = cacheKey(userId);
  const existing = pendingPatches.get(key) ?? [];
  pendingPatches.set(
    key,
    coalescePending([...existing, { mediaType, tmdbId, update }])
  );
  const snapshot = snapshots.get(userId);
  if (snapshot) {
    snapshots.set(userId, applyPendingPatches(snapshot, userId));
  }
}

export function lookupAnilistEntryByAnilistId(
  snapshot: AnilistUserSnapshot,
  anilistId: number
): AnilistSyncEntry | null {
  return (
    snapshot.entries.find((item) => item.anilistId === Number(anilistId)) ??
    null
  );
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
      const mapped = await anilistIdMapping.getFromAnilistId(anilistId);
      if (!mapped) {
        continue;
      }
      const key = String(anilistId);
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
  const cached = snapshots.get(userId);
  if (cached && !isExpired(cached, ttlSeconds)) {
    const snapshot = applyPendingPatches(cached, userId);
    snapshots.set(userId, snapshot);
    return snapshot;
  }

  const existingInflight = snapshots.getInflight(userId);
  if (existingInflight) {
    const snapshot = await existingInflight;
    return applyPendingPatches(snapshot, userId);
  }

  const generationAtStart = snapshots.generation(userId);
  const pending = fetchSnapshot(client, anilistUserId)
    .then((snapshot) => {
      if (snapshots.isStale(userId, generationAtStart)) {
        return snapshots.get(userId) ?? emptySnapshot();
      }
      const patched = applyPendingPatches(snapshot, userId);
      snapshots.set(userId, patched);
      return patched;
    })
    .finally(() => {
      snapshots.clearInflight(userId);
    });

  snapshots.setInflight(userId, pending);
  const snapshot = await pending;
  return applyPendingPatches(snapshot, userId);
}
