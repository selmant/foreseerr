import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hasDiscoverTmdbId,
  omitUnmappedDiscoverItems,
  shouldHideUnmappedFromQuery,
} from './unmapped';

describe('discover unmapped helpers', () => {
  it('treats missing and non-positive ids as unmapped', () => {
    assert.equal(hasDiscoverTmdbId(undefined), false);
    assert.equal(hasDiscoverTmdbId(0), false);
    assert.equal(hasDiscoverTmdbId(-1), false);
    assert.equal(hasDiscoverTmdbId(550), true);
  });

  it('omits unmapped items only when hideUnmapped is on', () => {
    const items = [{ tmdbId: 1 }, { tmdbId: undefined }, { tmdbId: 0 }];
    assert.equal(omitUnmappedDiscoverItems(items, false).length, 3);
    assert.deepEqual(omitUnmappedDiscoverItems(items, true), [{ tmdbId: 1 }]);
  });

  it('reads hideUnmapped from query truthy values', () => {
    assert.equal(shouldHideUnmappedFromQuery({}), false);
    assert.equal(shouldHideUnmappedFromQuery({ hideUnmapped: 'true' }), true);
    assert.equal(shouldHideUnmappedFromQuery({ hideUnmapped: true }), true);
    assert.equal(shouldHideUnmappedFromQuery({ hideUnmapped: 'false' }), false);
  });
});
