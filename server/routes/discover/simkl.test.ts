import type TheMovieDb from '@server/api/themoviedb';
import { resetTmdbValidityCache } from '@server/lib/discover/validity';
import type { ResolvedSimklItem } from '@server/lib/simklCatalog';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { toSimklWatchlistItems } from './simkl';

afterEach(() => {
  resetTmdbValidityCache();
});

const fakeTmdb = {
  getMovie: async ({ movieId }: { movieId: number }) => ({
    id: movieId,
    title: 'Motor City',
    poster_path: '/motor.jpg',
  }),
  getTvShow: async () => {
    throw new Error('should not fetch tv');
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
