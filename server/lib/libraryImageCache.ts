import { memoryCacheBudget } from '@server/lib/cache';
import { WeightedLruCacheStore } from '@server/lib/cacheStore';

export const LIBRARY_IMAGE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const LIBRARY_IMAGE_CACHE_MAX_ENTRIES = 256;
export const LIBRARY_IMAGE_CACHE_MAX_BYTES = 64 * 1024 * 1024;

type LibraryImageCacheEntry = {
  buffer: Buffer;
  contentType: string;
};

// Library artwork participates in the provider-response budget. Its local
// caps preserve the established cache behavior while the shared budget can
// reclaim it first when another cache needs memory.
const libraryImageCache = new WeightedLruCacheStore(
  memoryCacheBudget,
  LIBRARY_IMAGE_CACHE_TTL_MS / 1000,
  {
    maxEntries: LIBRARY_IMAGE_CACHE_MAX_ENTRIES,
    maxBytes: LIBRARY_IMAGE_CACHE_MAX_BYTES,
    estimateSize: (value) => {
      const entry = value as LibraryImageCacheEntry;
      return entry.buffer.byteLength + Buffer.byteLength(entry.contentType);
    },
  }
);

export const libraryImageCacheKey = (
  userId: number,
  jellyfinItemId: string,
  imageType: 'primary' | 'backdrop'
): string => `${userId}:${jellyfinItemId}:${imageType}`;

export const getCachedLibraryImage = (
  userId: number,
  jellyfinItemId: string,
  imageType: 'primary' | 'backdrop'
): { buffer: Buffer; contentType: string } | undefined => {
  const cached = libraryImageCache.get<LibraryImageCacheEntry>(
    libraryImageCacheKey(userId, jellyfinItemId, imageType)
  );
  return cached
    ? { buffer: cached.buffer, contentType: cached.contentType }
    : undefined;
};

export const setCachedLibraryImage = (
  userId: number,
  jellyfinItemId: string,
  imageType: 'primary' | 'backdrop',
  image: { buffer: Buffer; contentType: string }
): void => {
  libraryImageCache.set(
    libraryImageCacheKey(userId, jellyfinItemId, imageType),
    image,
    LIBRARY_IMAGE_CACHE_TTL_MS / 1000
  );
};

export const resetLibraryImageCache = (): void => {
  libraryImageCache.flush();
};

export const libraryImageCacheSize = (): number =>
  libraryImageCache.keys().length;
