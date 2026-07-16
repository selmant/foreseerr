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

  it('seeds a snapshot when user has no cached entry', () => {
    patchUserSyncItem(999, 'movie', 550, { watched: true });
    const snapshot = getUserSyncSnapshot(999);
    assert.ok(snapshot);
    assert.deepEqual(lookupItemStatus(snapshot, 'movie', 550), {
      watched: true,
      rating: null,
    });
  });

  it('keeps local mark-watched across a stale Trakt re-fetch', async () => {
    const { warmUserSyncCache } = await import('./syncCache');
    const client = {
      getSyncWatched: async (mediaType: 'movie' | 'tv') => {
        if (mediaType === 'movie') {
          // Stale: missing 550 that we just marked watched locally
          return [{ movie: { ids: { tmdb: 111 } } }];
        }
        return [];
      },
      getSyncRatings: async () => [],
    };

    patchUserSyncItem(42, 'movie', 550, { watched: true });
    assert.equal(
      lookupItemStatus(getUserSyncSnapshot(42)!, 'movie', 550).watched,
      true
    );

    // Expire by rewriting fetchedAt
    const snap = getUserSyncSnapshot(42)!;
    snap.fetchedAt = 1;

    const warmed = await warmUserSyncCache(client as never, 42, 60);
    assert.equal(lookupItemStatus(warmed, 'movie', 550).watched, true);
    assert.equal(lookupItemStatus(warmed, 'movie', 111).watched, true);
  });

  it('preserves mark-watched when a concurrent warm finishes after patch', async () => {
    const { warmUserSyncCache } = await import('./syncCache');
    let releaseFetch: () => void = () => undefined;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });

    const client = {
      getSyncWatched: async (mediaType: 'movie' | 'tv') => {
        await fetchGate;
        if (mediaType === 'movie') {
          return [{ movie: { ids: { tmdb: 111 } } }];
        }
        return [];
      },
      getSyncRatings: async () => {
        await fetchGate;
        return [];
      },
    };

    const warmPromise = warmUserSyncCache(client as never, 77, 60);
    // Allow the warm to start and hit the gate
    await new Promise((r) => setTimeout(r, 10));

    patchUserSyncItem(77, 'movie', 550, { watched: true });
    releaseFetch();

    const warmed = await warmPromise;
    assert.equal(lookupItemStatus(warmed, 'movie', 550).watched, true);
    assert.equal(lookupItemStatus(warmed, 'movie', 111).watched, true);
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
