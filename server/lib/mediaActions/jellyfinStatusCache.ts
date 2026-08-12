const CACHE_TTL_MS = 30_000;

type CachedStatus = {
  watched: boolean;
  expiresAt: number;
};

const statusByUser = new Map<string, CachedStatus>();

function cacheEntryKey(userId: number, jellyfinId: string): string {
  return `${userId}:${jellyfinId}`;
}

export function getCachedJellyfinWatched(
  userId: number,
  jellyfinId: string
): boolean | null {
  const entry = statusByUser.get(cacheEntryKey(userId, jellyfinId));
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    statusByUser.delete(cacheEntryKey(userId, jellyfinId));
    return null;
  }
  return entry.watched;
}

export function setCachedJellyfinWatched(
  userId: number,
  jellyfinId: string,
  watched: boolean
): void {
  statusByUser.set(cacheEntryKey(userId, jellyfinId), {
    watched,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

export function invalidateJellyfinStatusCache(userId?: number): void {
  if (userId == null) {
    statusByUser.clear();
    return;
  }
  const prefix = `${userId}:`;
  for (const key of statusByUser.keys()) {
    if (key.startsWith(prefix)) {
      statusByUser.delete(key);
    }
  }
}
