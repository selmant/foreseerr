import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  clearSyncCache,
  getUserSyncSnapshot,
  lookupItemStatus,
  patchUserSyncItem,
  seedUserSyncCache,
} from './syncCache';

describe('lookupItemStatus', () => {
  it('resolves watched and rating from snapshot', () => {
    clearSyncCache();
    const snapshot = {
      watchedMovies: [{ movie: { ids: { tmdb: 550 } } }],
      watchedShows: [],
      ratingsMovies: [{ movie: { ids: { tmdb: 550 } }, rating: 9 }],
      ratingsShows: [],
      fetchedAt: Date.now() / 1000,
    };

    assert.deepEqual(lookupItemStatus(snapshot, 'movie', 550), {
      watched: true,
      rating: 9,
    });
    assert.deepEqual(lookupItemStatus(snapshot, 'movie', 999), {
      watched: false,
      rating: null,
    });
  });
});

describe('patchUserSyncItem', () => {
  beforeEach(() => {
    clearSyncCache();
  });

  it('marks watched and upserts rating without dropping other items', () => {
    const fetchedAt = 1_700_000_000;
    seedUserSyncCache(1, {
      watchedMovies: [{ movie: { ids: { tmdb: 111 } } }],
      watchedShows: [],
      ratingsMovies: [{ movie: { ids: { tmdb: 111 } }, rating: 6 }],
      ratingsShows: [],
      fetchedAt,
    });

    patchUserSyncItem(1, 'movie', 550, { watched: true, rating: 8 });

    const snapshot = getUserSyncSnapshot(1);
    assert.ok(snapshot);
    assert.equal(snapshot.fetchedAt, fetchedAt);
    assert.deepEqual(lookupItemStatus(snapshot, 'movie', 550), {
      watched: true,
      rating: 8,
    });
    assert.deepEqual(lookupItemStatus(snapshot, 'movie', 111), {
      watched: true,
      rating: 6,
    });
  });

  it('unmarks watched and can clear rating', () => {
    seedUserSyncCache(2, {
      watchedMovies: [
        { movie: { ids: { tmdb: 550 } } },
        { movie: { ids: { tmdb: 111 } } },
      ],
      watchedShows: [],
      ratingsMovies: [
        { movie: { ids: { tmdb: 550 } }, rating: 9 },
        { movie: { ids: { tmdb: 111 } }, rating: 7 },
      ],
      ratingsShows: [],
      fetchedAt: 42,
    });

    patchUserSyncItem(2, 'movie', 550, { watched: false, rating: null });

    const snapshot = getUserSyncSnapshot(2);
    assert.ok(snapshot);
    assert.deepEqual(lookupItemStatus(snapshot, 'movie', 550), {
      watched: false,
      rating: null,
    });
    assert.deepEqual(lookupItemStatus(snapshot, 'movie', 111), {
      watched: true,
      rating: 7,
    });
  });

  it('patches tv shows via show key', () => {
    seedUserSyncCache(3, {
      watchedMovies: [],
      watchedShows: [],
      ratingsMovies: [],
      ratingsShows: [],
      fetchedAt: 99,
    });

    patchUserSyncItem(3, 'tv', 1399, { watched: true, rating: 10 });

    const snapshot = getUserSyncSnapshot(3);
    assert.ok(snapshot);
    assert.deepEqual(lookupItemStatus(snapshot, 'tv', 1399), {
      watched: true,
      rating: 10,
    });
  });

  it('is a no-op when user has no cached snapshot', () => {
    patchUserSyncItem(999, 'movie', 550, { watched: true });
    assert.equal(getUserSyncSnapshot(999), undefined);
  });

  it('updates rating only when watched omitted', () => {
    seedUserSyncCache(4, {
      watchedMovies: [{ movie: { ids: { tmdb: 550 } } }],
      watchedShows: [],
      ratingsMovies: [{ movie: { ids: { tmdb: 550 } }, rating: 4 }],
      ratingsShows: [],
      fetchedAt: 1,
    });

    patchUserSyncItem(4, 'movie', 550, { rating: 10 });

    const snapshot = getUserSyncSnapshot(4);
    assert.ok(snapshot);
    assert.deepEqual(lookupItemStatus(snapshot, 'movie', 550), {
      watched: true,
      rating: 10,
    });
  });
});
