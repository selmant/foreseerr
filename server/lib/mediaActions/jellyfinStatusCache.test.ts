import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getCachedJellyfinWatched,
  invalidateJellyfinStatusCache,
  setCachedJellyfinWatched,
} from './jellyfinStatusCache';

describe('jellyfin status cache', () => {
  it('stores and returns watched state until invalidated', () => {
    setCachedJellyfinWatched(7, 'item-1', true);
    assert.equal(getCachedJellyfinWatched(7, 'item-1'), true);
    invalidateJellyfinStatusCache(7);
    assert.equal(getCachedJellyfinWatched(7, 'item-1'), null);
  });
});
