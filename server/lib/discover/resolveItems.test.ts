import type TheMovieDb from '@server/api/themoviedb';
import { setupTestDb } from '@server/test/db';
import { edge, seedEdges } from '@server/test/mapping';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { resolveDiscoverItems } from './resolveItems';
import { resetTmdbValidityCache } from './validity';

setupTestDb();

afterEach(() => {
  resetTmdbValidityCache();
});

/** `find` answers TMDB's `/find` by external id. */
const fakeTmdb = (find: Record<string, { tv?: number[] }> = {}) =>
  ({
    getMovie: async () => {
      throw new Error('404');
    },
    getTvShow: async ({ tvId }: { tvId: number }) => ({
      id: tvId,
      name: 'Breaking Bad',
      poster_path: '/bb.jpg',
    }),
    getByExternalId: async ({
      externalId,
    }: {
      externalId: string | number;
    }) => ({
      movie_results: [],
      tv_results: (find[String(externalId)]?.tv ?? []).map((id) => ({ id })),
    }),
  }) as unknown as TheMovieDb;

describe('resolveDiscoverItems', () => {
  it('takes mediaType from the answer when the source omitted it', async () => {
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
      {
        discoverSource: 'mdblist/list',
        tmdb: fakeTmdb({ tt0903747: { tv: [1396] } }),
      }
    );
    assert.equal(item.tmdbId, 1396);
    assert.equal(item.id, 1396);
    assert.equal(item.mediaType, 'tv');
    assert.equal(item.posterPath, '/bb.jpg');
    assert.deepEqual(item.mappingState, {
      state: 'mapped',
      sourceKey: 'tmdb-find',
      namespace: 'imdb',
      externalId: 'tt0903747',
    });
  });

  it('leaves unmapped unified items without a mediaType', async () => {
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
      { discoverSource: 'mdblist/list', tmdb: fakeTmdb() }
    );
    assert.equal(item.tmdbId, undefined);
    assert.equal(item.mediaType, undefined);
    assert.equal(item.mappingState?.state, 'unmapped');
    assert.equal(item.mappingState?.namespace, 'tvdb_show');
    assert.equal(item.mappingState?.externalId, '73740');
  });

  it('answers from the dataset for an anime id, with its declared type', async () => {
    await seedEdges(edge('anilist:16498', 'tmdb_show:1429:s1'));
    const [item] = await resolveDiscoverItems(
      [
        {
          id: 0,
          ratingKey: 'x',
          title: 'Attack on Titan',
          mediaType: 'tv',
          from: { ns: 'anilist', id: '16498' },
        },
      ],
      { discoverSource: 'test', tmdb: fakeTmdb() }
    );
    assert.equal(item.tmdbId, 1429);
    assert.equal(item.mappingState?.sourceKey, 'dataset');
  });
});
