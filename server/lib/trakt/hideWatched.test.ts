import type { UserSyncSnapshot } from '@server/lib/mediaActions/syncCache';
import {
  clearSyncCache,
  getUserSyncSnapshot,
  patchUserSyncItem,
  seedUserSyncCache,
} from '@server/lib/mediaActions/syncCache';
import type { MovieResult, TvResult } from '@server/models/Search';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildWatchedIdSets,
  filterWatchedMixedBrowseResults,
  filterWatchedTraktItems,
  isWatchedInSets,
} from './hideWatched';

describe('hideWatched', () => {
  const snapshot: UserSyncSnapshot = {
    watchedMovies: [{ movie: { ids: { tmdb: 550 } } }],
    watchedShows: [{ show: { ids: { tmdb: 1399 } } }],
    ratingsMovies: [],
    ratingsShows: [],
    fetchedAt: 1,
  };

  it('builds watched id sets from sync snapshot', () => {
    const sets = buildWatchedIdSets(snapshot);
    assert.equal(isWatchedInSets(sets, 'movie', 550), true);
    assert.equal(isWatchedInSets(sets, 'movie', 999), false);
    assert.equal(isWatchedInSets(sets, 'tv', 1399), true);
  });

  it('filters trakt and browse items', () => {
    const sets = buildWatchedIdSets(snapshot);
    const traktItems = filterWatchedTraktItems(
      [
        { tmdbId: 550, mediaType: 'movie', title: 'Fight Club' },
        { tmdbId: 999, mediaType: 'movie', title: 'Other' },
        { tmdbId: 1399, mediaType: 'tv', title: 'GoT' },
      ],
      sets
    );
    assert.deepEqual(
      traktItems.map((i) => i.tmdbId),
      [999]
    );

    const browse = filterWatchedMixedBrowseResults(
      [
        {
          id: 550,
          mediaType: 'movie',
          title: 'Fight Club',
        } satisfies Pick<MovieResult, 'id' | 'mediaType' | 'title'>,
        {
          id: 42,
          mediaType: 'tv',
          name: 'Show',
        } satisfies Pick<TvResult, 'id' | 'mediaType' | 'name'>,
      ],
      sets
    );
    assert.deepEqual(
      browse.map((i) => i.id),
      [42]
    );
  });

  it('picks up titles marked watched via sync cache patch', () => {
    clearSyncCache();
    seedUserSyncCache(7, {
      watchedMovies: [],
      watchedShows: [],
      ratingsMovies: [],
      ratingsShows: [],
      fetchedAt: Date.now() / 1000,
    });

    const before = buildWatchedIdSets(getUserSyncSnapshot(7)!);
    assert.equal(isWatchedInSets(before, 'movie', 550), false);

    patchUserSyncItem(7, 'movie', 550, { watched: true });

    const after = buildWatchedIdSets(getUserSyncSnapshot(7)!);
    assert.equal(isWatchedInSets(after, 'movie', 550), true);
    assert.deepEqual(
      filterWatchedTraktItems(
        [
          { tmdbId: 550, mediaType: 'movie', title: 'Fight Club' },
          { tmdbId: 999, mediaType: 'movie', title: 'Other' },
        ],
        after
      ).map((i) => i.tmdbId),
      [999]
    );
  });
});
