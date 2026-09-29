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
    backdrop_path: '/madmax-backdrop.jpg',
    release_date: '2015-05-13',
  }),
  getTvShow: async ({ tvId }: { tvId: number }) => ({
    id: tvId,
    name: 'Frieren',
    poster_path: '/frieren.jpg',
    backdrop_path: '/frieren-backdrop.jpg',
    first_air_date: '2023-09-29',
  }),
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

  it('adds the backdrop and release date from the same probe', async () => {
    let calls = 0;
    const tmdb = {
      getMovie: async (args: { movieId: number }) => {
        calls += 1;
        return fakeTmdb.getMovie(args);
      },
    } as unknown as TheMovieDb;
    const tile = {
      id: 900002,
      ratingKey: 'trakt-movie-900002',
      tmdbId: 900002,
      mediaType: 'movie' as const,
      title: 'Mad Max: Fury Road',
      source: 'trakt' as const,
      mappingState: { state: 'mapped' as const },
    };
    const item = await withTmdbPoster(tile, tmdb);
    assert.deepEqual(item, {
      ...tile,
      posterPath: '/madmax.jpg',
      backdropPath: '/madmax-backdrop.jpg',
      releaseDate: '2015-05-13',
    });
    // A second tile for the same id reuses the cached probe.
    await withTmdbPoster({ ...tile, ratingKey: 'again' }, tmdb);
    assert.equal(calls, 1);
  });

  it('uses firstAirDate for series', async () => {
    const item = await withTmdbPoster(
      {
        id: 209867,
        ratingKey: 'anilist-tv-154587',
        tmdbId: 209867,
        mediaType: 'tv',
        title: 'Frieren',
        source: 'anilist',
      },
      fakeTmdb
    );
    assert.equal(item.posterPath, '/frieren.jpg');
    assert.equal(item.backdropPath, '/frieren-backdrop.jpg');
    assert.equal(item.firstAirDate, '2023-09-29');
    assert.equal(item.releaseDate, undefined);
  });

  it('leaves unmapped tiles alone', async () => {
    const tile = {
      id: 0,
      ratingKey: 'simkl-movie-1',
      mediaType: 'movie' as const,
      title: 'Nowhere',
    };
    assert.deepEqual(await withTmdbPoster(tile, fakeTmdb), tile);
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
