import type TheMovieDb from '@server/api/themoviedb';
import { clearNegativeCache, resetBudgets } from '@server/lib/mapping/budget';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { withTmdbPoster } from './posters';
import { resetTmdbValidityCache } from './validity';

beforeEach(() => {
  resetBudgets();
  clearNegativeCache();
  resetTmdbValidityCache();
});

afterEach(() => {
  resetTmdbValidityCache();
});

const fakeTmdb = {
  getMovie: async ({ movieId }: { movieId: number }) => ({
    id: movieId,
    title: 'Mad Max: Fury Road',
    poster_path: '/madmax.jpg',
  }),
  getTvShow: async () => {
    throw new Error('should not fetch tv');
  },
} as unknown as TheMovieDb;

describe('withTmdbPoster', () => {
  it('copies the poster the confirm probe already fetched', async () => {
    const item = await withTmdbPoster(
      {
        id: 900001,
        ratingKey: 'trakt-movie-900001',
        tmdbId: 900001,
        mediaType: 'movie',
        title: 'Mad Max: Fury Road',
        source: 'trakt',
      },
      fakeTmdb
    );
    assert.equal(item.posterPath, '/madmax.jpg');
  });

  it('leaves an existing poster alone', async () => {
    let calls = 0;
    const tmdb = {
      getMovie: async () => {
        calls += 1;
        return { poster_path: '/other.jpg' };
      },
    } as unknown as TheMovieDb;
    const item = await withTmdbPoster(
      {
        id: 1,
        ratingKey: 'x',
        tmdbId: 1,
        mediaType: 'movie',
        title: 'Has Poster',
        posterPath: '/already.jpg',
      },
      tmdb
    );
    assert.equal(item.posterPath, '/already.jpg');
    assert.equal(calls, 0);
  });
});
