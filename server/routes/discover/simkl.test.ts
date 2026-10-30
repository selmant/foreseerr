import type TheMovieDb from '@server/api/themoviedb';
import { resetTmdbValidityCache } from '@server/lib/discover/validity';
import { clearTmdbNegativeCache } from '@server/lib/mapping/tmdb';
import type { ResolvedSimklItem } from '@server/lib/simklCatalog';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { tmdbResolvers, toSimklWatchlistItems } from './simkl';

afterEach(() => {
  resetTmdbValidityCache();
});

const fakeTmdb = {
  getTitleSummary: async ({
    mediaType,
    tmdbId,
  }: {
    mediaType: 'movie' | 'tv';
    tmdbId: number;
  }) => {
    if (mediaType === 'tv') throw new Error('should not fetch tv');
    return { id: tmdbId, title: 'Motor City', poster_path: '/motor.jpg' };
  },
} as unknown as TheMovieDb;

const mappedMovie = (): ResolvedSimklItem => ({
  item: {
    id: 123,
    ratingKey: 'simkl-movie-180364',
    tmdbId: 123,
    mediaType: 'movie',
    title: 'Motor City',
    source: 'simkl',
    sourceId: '180364',
    image: 'https://simkl.in/posters/20/205643_w.webp',
  },
  resolution: { confidence: 90, sourceKey: 'simkl-ids' },
  candidate: {
    isAnime: false,
    typedFromSource: true,
    ids: { tmdb: 123 },
    item: {
      id: 123,
      ratingKey: 'simkl-movie-180364',
      tmdbId: 123,
      mediaType: 'movie',
      title: 'Motor City',
      source: 'simkl',
      sourceId: '180364',
    },
  },
});

describe('toSimklWatchlistItems', () => {
  it('puts TMDB posterPath on mapped tiles that only had a Simkl image', async () => {
    const [item] = await toSimklWatchlistItems([mappedMovie()], true, fakeTmdb);
    assert.equal(item.posterPath, '/motor.jpg');
    assert.equal(item.image, 'https://simkl.in/posters/20/205643_w.webp');
  });
});

describe('tmdbResolvers', () => {
  it('remembers an id TMDB /find does not know', async () => {
    clearTmdbNegativeCache();
    let calls = 0;
    const tmdb = {
      getByExternalId: async ({ externalId }: { externalId: string }) => {
        calls += 1;
        return externalId === 'tt9700001'
          ? { movie_results: [{ id: 9_700_001 }], tv_results: [] }
          : { movie_results: [], tv_results: [] };
      },
    } as unknown as TheMovieDb;
    const { findByExternalId } = tmdbResolvers(tmdb);
    assert.deepEqual(
      await findByExternalId('imdb', 'tt9700001', 'movie'),
      [9_700_001]
    );
    assert.deepEqual(await findByExternalId('imdb', 'tt9700001', 'tv'), []);
    assert.deepEqual(await findByExternalId('imdb', 'tt9700002', 'tv'), []);
    assert.deepEqual(await findByExternalId('imdb', 'tt9700002', 'tv'), []);
    assert.equal(calls, 3, 'the unknown id is asked once');
    assert.deepEqual(await findByExternalId('tvdb', '1', 'movie'), []);
    assert.equal(calls, 3, 'never asks TVDB for a movie');
  });
});
