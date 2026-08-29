import type TheMovieDb from '@server/api/themoviedb';
import mappingService from '@server/lib/mapping/service';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { resolveDiscoverItems } from './resolveItems';
import { resetTmdbValidityCache } from './validity';

setupTestDb();

afterEach(() => {
  resetTmdbValidityCache();
});

const fakeTmdb = {
  getMovie: async () => {
    throw new Error('404');
  },
  getTvShow: async ({ tvId }: { tvId: number }) => ({
    id: tvId,
    name: 'Breaking Bad',
  }),
} as unknown as TheMovieDb;

describe('resolveDiscoverItems', () => {
  it('sets mediaType from the winning namespace when the source omitted it', async () => {
    const asked: string[] = [];
    const original = mappingService.resolve.bind(mappingService);
    mappingService.resolve = (async (_from, to) => {
      asked.push(to);
      if (to === 'tmdb_show') {
        return {
          target: { ns: 'tmdb_show', id: '1396' },
          confidence: 90,
          sourceKey: 'graph',
          candidates: [],
          ambiguous: false,
          layer: 'graph',
        };
      }
      return {
        confidence: 0,
        sourceKey: 'none',
        candidates: [],
        ambiguous: false,
        layer: 'none',
      };
    }) as typeof mappingService.resolve;

    try {
      const [item] = await resolveDiscoverItems(
        [
          {
            id: 0,
            ratingKey: 'mdblist-unknown-tt0903747',
            title: 'Breaking Bad',
            source: 'mdblist',
            sourceId: 'tt0903747',
            from: { ns: 'imdb', id: 'tt0903747' },
          },
        ],
        { discoverSource: 'mdblist/list', tmdb: fakeTmdb }
      );
      assert.deepEqual(asked, ['tmdb_movie', 'tmdb_show']);
      assert.equal(item.tmdbId, 1396);
      assert.equal(item.mediaType, 'tv');
    } finally {
      mappingService.resolve = original;
    }
  });

  it('leaves unmapped unified items without a mediaType', async () => {
    const original = mappingService.resolve.bind(mappingService);
    mappingService.resolve = (async () => ({
      confidence: 0,
      sourceKey: 'none',
      candidates: [],
      ambiguous: false,
      layer: 'none',
    })) as typeof mappingService.resolve;

    try {
      const [item] = await resolveDiscoverItems(
        [
          {
            id: 0,
            ratingKey: 'mdblist-unknown-73740',
            title: 'Some Show',
            source: 'mdblist',
            sourceId: '73740',
            from: { ns: 'tvdb_show', id: '73740' },
          },
        ],
        { discoverSource: 'mdblist/list', tmdb: fakeTmdb }
      );
      assert.equal(item.tmdbId, undefined);
      assert.equal(item.mediaType, undefined);
      assert.equal(item.mappingState?.namespace, 'tvdb_show');
      assert.equal(item.mappingState?.externalId, '73740');
    } finally {
      mappingService.resolve = original;
    }
  });
});
