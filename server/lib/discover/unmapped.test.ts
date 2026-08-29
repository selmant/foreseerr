import { getRepository } from '@server/datasource';
import { MappingGap } from '@server/entity/MappingGap';
import { flushMappingGaps } from '@server/lib/mapping/gaps';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  hasDiscoverTmdbId,
  omitUnmappedDiscoverItems,
  recordUnmappedItems,
  shouldHideUnmappedFromQuery,
} from './unmapped';

setupTestDb();

beforeEach(async () => {
  await flushMappingGaps();
  await getRepository(MappingGap).clear();
});

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
    await flushMappingGaps();
    const [gap] = await getRepository(MappingGap).find();
    assert.equal(gap.namespace, 'tvdb_show');
    assert.equal(gap.externalId, '73740');
  });
});
