export const LIBRARY_IMAGE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const LIBRARY_IMAGE_CACHE_MAX_ENTRIES = 256;
export const LIBRARY_IMAGE_CACHE_MAX_BYTES = 64 * 1024 * 1024;

type LibraryImageCacheEntry = {
  buffer: Buffer;
  contentType: string;
  expiresAt: number;
  lastAccessAt: number;
};

const libraryImageCache = new Map<string, LibraryImageCacheEntry>();

export const libraryImageCacheKey = (
  userId: number,
  jellyfinItemId: string,
  imageType: 'primary' | 'backdrop'
): string => `${userId}:${jellyfinItemId}:${imageType}`;

const cacheBytes = (): number => {
  let total = 0;
  for (const entry of libraryImageCache.values()) {
    total += entry.buffer.byteLength;
  }
  return total;
};

const evictIfNeeded = (incomingBytes: number): void => {
  while (
    libraryImageCache.size >= LIBRARY_IMAGE_CACHE_MAX_ENTRIES ||
    cacheBytes() + incomingBytes > LIBRARY_IMAGE_CACHE_MAX_BYTES
  ) {
    let oldestKey: string | undefined;
    let oldestAccess = Number.POSITIVE_INFINITY;
    for (const [key, entry] of libraryImageCache) {
      if (entry.lastAccessAt < oldestAccess) {
        oldestAccess = entry.lastAccessAt;
        oldestKey = key;
      }
    }
    if (!oldestKey) {
      break;
    }
    libraryImageCache.delete(oldestKey);
  }
};

export const getCachedLibraryImage = (
  userId: number,
  jellyfinItemId: string,
  imageType: 'primary' | 'backdrop'
): { buffer: Buffer; contentType: string } | undefined => {
  const key = libraryImageCacheKey(userId, jellyfinItemId, imageType);
  const cached = libraryImageCache.get(key);
  if (!cached) {
    return undefined;
  }
  if (cached.expiresAt <= Date.now()) {
    libraryImageCache.delete(key);
    return undefined;
  }
  cached.lastAccessAt = Date.now();
  return { buffer: cached.buffer, contentType: cached.contentType };
};

export const setCachedLibraryImage = (
  userId: number,
  jellyfinItemId: string,
  imageType: 'primary' | 'backdrop',
  image: { buffer: Buffer; contentType: string }
): void => {
  evictIfNeeded(image.buffer.byteLength);
  libraryImageCache.set(
    libraryImageCacheKey(userId, jellyfinItemId, imageType),
    {
      ...image,
      expiresAt: Date.now() + LIBRARY_IMAGE_CACHE_TTL_MS,
      lastAccessAt: Date.now(),
    }
  );
};

export const resetLibraryImageCache = (): void => {
  libraryImageCache.clear();
};

export const libraryImageCacheSize = (): number => libraryImageCache.size;
