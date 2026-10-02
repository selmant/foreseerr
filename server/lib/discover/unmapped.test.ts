import { flushMisses, listResolutions } from '@server/lib/mapping/resolutions';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hasDiscoverTmdbId,
  omitUnmappedDiscoverItems,
  recordUnmappedItems,
  shouldHideUnmappedFromQuery,
} from './unmapped';

setupTestDb();

describe('discover unmapped helpers', () => {
  it('treats missing and non-positive ids as unmapped', () => {
    assert.equal(hasDiscoverTmdbId(undefined), false);
    assert.equal(hasDiscoverTmdbId(0), false);
    assert.equal(hasDiscoverTmdbId(-1), false);
    assert.equal(hasDiscoverTmdbId(550), true);
  });

  it('omits unmapped items only when hideUnmapped is on', () => {
    const items = [
      { tmdbId: 1, mediaType: 'movie' },
      { tmdbId: 2, mediaType: 'tv' },
      { tmdbId: undefined, mediaType: 'movie' },
      { tmdbId: 0, mediaType: 'tv' },
      // A unified MDBList item can carry an id with no type.
      { tmdbId: 3 },
    ];
    assert.equal(omitUnmappedDiscoverItems(items, false).length, 5);
    assert.deepEqual(omitUnmappedDiscoverItems(items, true), [
      { tmdbId: 1, mediaType: 'movie' },
      { tmdbId: 2, mediaType: 'tv' },
    ]);
  });

  it('reads hideUnmapped from query truthy values', () => {
    assert.equal(shouldHideUnmappedFromQuery({}), false);
    assert.equal(shouldHideUnmappedFromQuery({ hideUnmapped: 'true' }), true);
    assert.equal(shouldHideUnmappedFromQuery({ hideUnmapped: true }), true);
    assert.equal(shouldHideUnmappedFromQuery({ hideUnmapped: 'false' }), false);
  });

  it('records TVDB-only items under tvdb_show from mappingState', async () => {
    recordUnmappedItems(
      [
        {
          title: 'Some Show',
          source: 'mdblist',
          sourceId: 'Some Show',
          mappingState: {
            state: 'unmapped',
            namespace: 'tvdb_show',
            externalId: '73740',
          },
        },
      ],
      { discoverSource: 'mdblist/list', namespace: 'imdb' }
    );
    await flushMisses();
    const [miss] = (await listResolutions('unmapped')).results;
    assert.equal(miss.srcNs, 'tvdb_show');
    assert.equal(miss.srcId, '73740');
    assert.equal(miss.discoverSource, 'mdblist/list');
  });
});
