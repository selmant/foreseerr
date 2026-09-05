import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import {
  ANILIST_NOT_MAPPED_ERROR,
  AnilistMediaActionProvider,
} from './anilist';
import {
  clearAnilistSyncCache,
  seedUserAnilistSyncCache,
} from './anilistSyncCache';

const movie = { mediaType: 'movie' as const, tmdbId: 128 };
const tv = { mediaType: 'tv' as const, tmdbId: 26209 };

afterEach(() => {
  mock.restoreAll();
});

describe('AnilistMediaActionProvider', () => {
  it('reports unmapped writes as unavailable', async () => {
    const mapping = await import('@server/lib/anilist/mapping');
    mock.method(mapping.default, 'sync', async () => undefined);
    mock.method(mapping.default, 'getAnilistId', () => undefined);

    const provider = new AnilistMediaActionProvider();
    const marked = await provider.markWatched(1, movie);
    const rated = await provider.rate(1, tv, { ratingStars: 4 });

    assert.equal(marked.watched, false);
    assert.equal(marked.rating, null);
    assert.equal(marked.error, ANILIST_NOT_MAPPED_ERROR);
    assert.equal(rated.watched, false);
    assert.equal(rated.rating, null);
    assert.equal(rated.error, ANILIST_NOT_MAPPED_ERROR);
  });

  it('reads completed list entries as watched with a 1–10 score', async () => {
    clearAnilistSyncCache();
    seedUserAnilistSyncCache(7, {
      fetchedAt: Date.now() / 1000,
      entries: [
        {
          anilistId: 164,
          listEntryId: 99,
          tmdbId: 128,
          mediaType: 'movie',
          status: 'COMPLETED',
          rating: 8,
        },
      ],
    });

    const mapping = await import('@server/lib/anilist/mapping');
    mock.method(mapping.default, 'sync', async () => undefined);
    mock.method(mapping.default, 'getAnilistId', () => 164);

    const anilist = await import('@server/lib/anilist');
    mock.method(
      anilist.anilistFns,
      'createAnilistUserClient',
      async () => ({}) as never
    );
    mock.method(anilist.anilistFns, 'getUserAnilistSettings', async () => ({
      anilistUserId: '12',
    }));

    const provider = new AnilistMediaActionProvider();
    const status = await provider.getStatus(7, movie);

    assert.equal(status.watched, true);
    assert.equal(status.rating, 8);
    assert.equal(status.ratingStars, 4);
  });

  it('preserves the AniList entry and rating when unwatching by default', async () => {
    clearAnilistSyncCache();
    seedUserAnilistSyncCache(7, {
      fetchedAt: Date.now() / 1000,
      entries: [
        {
          anilistId: 164,
          listEntryId: 99,
          tmdbId: 128,
          mediaType: 'movie',
          status: 'COMPLETED',
          rating: 8,
        },
      ],
    });

    const mapping = await import('@server/lib/anilist/mapping');
    mock.method(mapping.default, 'sync', async () => undefined);
    mock.method(mapping.default, 'getAnilistId', () => 164);

    const saveMediaListEntry = mock.fn(
      async (_options: {
        mediaId: number;
        status?: string;
        scoreRaw?: number;
      }) => {
        void _options;
        return { id: 99, status: 'PLANNING' as const };
      }
    );
    const deleteMediaListEntry = mock.fn(async (_entryId: number) => {
      void _entryId;
      return true;
    });
    const anilist = await import('@server/lib/anilist');
    mock.method(
      anilist.anilistFns,
      'createAnilistUserClient',
      async () => ({ saveMediaListEntry, deleteMediaListEntry }) as never
    );
    mock.method(anilist.anilistFns, 'getUserAnilistSettings', async () => ({
      anilistUserId: '12',
    }));

    const provider = new AnilistMediaActionProvider();
    const status = await provider.unmarkWatched(7, movie);

    assert.equal(status.watched, false);
    assert.equal(status.rating, 8);
    assert.deepEqual(saveMediaListEntry.mock.calls[0].arguments[0], {
      mediaId: 164,
      status: 'PLANNING',
      scoreRaw: 80,
    });
    assert.equal(deleteMediaListEntry.mock.calls.length, 0);
  });

  it('removes the AniList entry only when unwatching with removeRating', async () => {
    clearAnilistSyncCache();
    seedUserAnilistSyncCache(7, {
      fetchedAt: Date.now() / 1000,
      entries: [
        {
          anilistId: 164,
          listEntryId: 99,
          tmdbId: 128,
          mediaType: 'movie',
          status: 'COMPLETED',
          rating: 8,
        },
      ],
    });

    const mapping = await import('@server/lib/anilist/mapping');
    mock.method(mapping.default, 'sync', async () => undefined);
    mock.method(mapping.default, 'getAnilistId', () => 164);

    const saveMediaListEntry = mock.fn(
      async (_options: {
        mediaId: number;
        status?: string;
        scoreRaw?: number;
      }) => {
        void _options;
        return { id: 99, status: 'PLANNING' as const };
      }
    );
    const deleteMediaListEntry = mock.fn(async (_entryId: number) => {
      void _entryId;
      return true;
    });
    const anilist = await import('@server/lib/anilist');
    mock.method(
      anilist.anilistFns,
      'createAnilistUserClient',
      async () => ({ saveMediaListEntry, deleteMediaListEntry }) as never
    );
    mock.method(anilist.anilistFns, 'getUserAnilistSettings', async () => ({
      anilistUserId: '12',
    }));

    const provider = new AnilistMediaActionProvider();
    const status = await provider.unmarkWatched(7, movie, {
      removeRating: true,
    });

    assert.equal(status.watched, false);
    assert.equal(status.rating, null);
    assert.equal(saveMediaListEntry.mock.calls.length, 0);
    assert.deepEqual(deleteMediaListEntry.mock.calls[0].arguments, [99]);
  });

  it('does not add an AniList entry when default-unwatching an absent item', async () => {
    clearAnilistSyncCache();
    seedUserAnilistSyncCache(7, {
      fetchedAt: Date.now() / 1000,
      entries: [],
    });

    const mapping = await import('@server/lib/anilist/mapping');
    mock.method(mapping.default, 'sync', async () => undefined);
    mock.method(mapping.default, 'getAnilistId', () => 164);

    const saveMediaListEntry = mock.fn(async () => ({
      id: 99,
      status: 'PLANNING' as const,
    }));
    const anilist = await import('@server/lib/anilist');
    mock.method(
      anilist.anilistFns,
      'createAnilistUserClient',
      async () => ({ saveMediaListEntry }) as never
    );
    mock.method(anilist.anilistFns, 'getUserAnilistSettings', async () => ({
      anilistUserId: '12',
    }));

    const provider = new AnilistMediaActionProvider();
    const status = await provider.unmarkWatched(7, movie);

    assert.equal(status.watched, false);
    assert.equal(status.rating, null);
    assert.equal(saveMediaListEntry.mock.calls.length, 0);
    assert.deepEqual(
      (await import('./anilistSyncCache')).getUserAnilistSnapshot(7)?.entries,
      []
    );
  });

  it('isAvailable is false when the admin disables AniList actions', async () => {
    const settingsLib = await import('@server/lib/settings');
    mock.method(settingsLib.settingsFns, 'getSettings', () => ({
      mediaActions: { providers: { anilist: false } },
    }));
    const anilist = await import('@server/lib/anilist');
    const createClient = mock.method(
      anilist.anilistFns,
      'createAnilistUserClient',
      async () => ({}) as never
    );

    const provider = new AnilistMediaActionProvider();
    assert.equal(await provider.isAvailable(1), false);
    assert.equal(createClient.mock.calls.length, 0);
  });

  it('isAvailable is false when the user disables AniList watch sync', async () => {
    const settingsLib = await import('@server/lib/settings');
    mock.method(settingsLib.settingsFns, 'getSettings', () => ({
      mediaActions: { providers: { anilist: true } },
    }));
    const anilist = await import('@server/lib/anilist');
    mock.method(anilist.anilistFns, 'getAnilistAppCredentials', () => ({
      clientId: 'id',
      clientSecret: 'secret',
    }));
    mock.method(anilist.anilistFns, 'getUserAnilistSettings', async () => ({
      mediaActionsAnilistEnabled: false,
    }));
    const createClient = mock.method(
      anilist.anilistFns,
      'createAnilistUserClient',
      async () => ({}) as never
    );

    const provider = new AnilistMediaActionProvider();
    assert.equal(await provider.isAvailable(7), false);
    assert.equal(createClient.mock.calls.length, 0);
  });

  it('isAvailable is true when the user toggle is missing and the account is linked', async () => {
    const settingsLib = await import('@server/lib/settings');
    mock.method(settingsLib.settingsFns, 'getSettings', () => ({
      mediaActions: { providers: { anilist: true } },
    }));
    const anilist = await import('@server/lib/anilist');
    mock.method(anilist.anilistFns, 'getAnilistAppCredentials', () => ({
      clientId: 'id',
      clientSecret: 'secret',
    }));
    mock.method(anilist.anilistFns, 'getUserAnilistSettings', async () => ({
      mediaActionsAnilistEnabled: null,
    }));
    mock.method(
      anilist.anilistFns,
      'createAnilistUserClient',
      async () => ({}) as never
    );

    const provider = new AnilistMediaActionProvider();
    assert.equal(await provider.isAvailable(7), true);
  });
});
