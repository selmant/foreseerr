import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  LIBRARY_IMAGE_CACHE_MAX_ENTRIES,
  getCachedLibraryImage,
  libraryImageCacheSize,
  resetLibraryImageCache,
  setCachedLibraryImage,
} from './libraryImageCache';

afterEach(() => {
  resetLibraryImageCache();
});

describe('libraryImageCache', () => {
  it('scopes artwork bytes to the requesting user', () => {
    setCachedLibraryImage(1, 'item-a', 'primary', {
      buffer: Buffer.from('user-one'),
      contentType: 'image/jpeg',
    });
    setCachedLibraryImage(2, 'item-a', 'primary', {
      buffer: Buffer.from('user-two'),
      contentType: 'image/jpeg',
    });

    assert.equal(
      getCachedLibraryImage(1, 'item-a', 'primary')?.buffer.toString(),
      'user-one'
    );
    assert.equal(
      getCachedLibraryImage(2, 'item-a', 'primary')?.buffer.toString(),
      'user-two'
    );
    assert.equal(getCachedLibraryImage(3, 'item-a', 'primary'), undefined);
  });

  it('evicts the least-recently-used entry once the max size is reached', () => {
    for (let index = 0; index < LIBRARY_IMAGE_CACHE_MAX_ENTRIES; index += 1) {
      setCachedLibraryImage(1, `item-${index}`, 'primary', {
        buffer: Buffer.from(`image-${index}`),
        contentType: 'image/jpeg',
      });
    }
    assert.equal(libraryImageCacheSize(), LIBRARY_IMAGE_CACHE_MAX_ENTRIES);
    assert.ok(getCachedLibraryImage(1, 'item-0', 'primary'));

    setCachedLibraryImage(1, 'item-overflow', 'primary', {
      buffer: Buffer.from('overflow'),
      contentType: 'image/jpeg',
    });

    assert.equal(libraryImageCacheSize(), LIBRARY_IMAGE_CACHE_MAX_ENTRIES);
    assert.equal(getCachedLibraryImage(1, 'item-1', 'primary'), undefined);
    assert.ok(getCachedLibraryImage(1, 'item-0', 'primary'));
    assert.ok(getCachedLibraryImage(1, 'item-overflow', 'primary'));
  });
});
