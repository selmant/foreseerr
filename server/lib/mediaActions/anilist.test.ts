import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { AnilistMediaActionProvider } from './anilist';
import {
  clearAnilistSyncCache,
  seedUserAnilistSyncCache,
} from './anilistSyncCache';

const movie = { mediaType: 'movie' as const, tmdbId: 128 };
const tv = { mediaType: 'tv' as const, tmdbId: 26209 };

describe('AnilistMediaActionProvider', () => {
  it('no-ops writes for titles without an AniList mapping', async () => {
    const mapping = await import('@server/lib/anilist/mapping');
    mock.method(mapping.default, 'sync', async () => undefined);
    mock.method(mapping.default, 'getAnilistId', () => undefined);

    const provider = new AnilistMediaActionProvider();
    const marked = await provider.markWatched(1, movie);
    const rated = await provider.rate(1, tv, { ratingStars: 4 });

    assert.equal(marked.watched, false);
    assert.equal(marked.rating, null);
    assert.equal(rated.watched, false);
    assert.equal(rated.rating, null);
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
    mock.method(anilist, 'createAnilistUserClient', async () => ({}) as never);
    mock.method(anilist, 'getUserAnilistSettings', async () => ({
      anilistUserId: '12',
    }));

    const provider = new AnilistMediaActionProvider();
    const status = await provider.getStatus(7, movie);

    assert.equal(status.watched, true);
    assert.equal(status.rating, 8);
    assert.equal(status.ratingStars, 4);
  });

  it('isAvailable is false when the admin disables AniList actions', async () => {
    const settingsLib = await import('@server/lib/settings');
    mock.method(settingsLib, 'getSettings', () => ({
      mediaActions: { providers: { anilist: false } },
    }));
    const anilist = await import('@server/lib/anilist');
    const createClient = mock.method(
      anilist,
      'createAnilistUserClient',
      async () => ({}) as never
    );

    const provider = new AnilistMediaActionProvider();
    assert.equal(await provider.isAvailable(1), false);
    assert.equal(createClient.mock.calls.length, 0);
  });

  it('isAvailable is false when the user disables AniList watch sync', async () => {
    const settingsLib = await import('@server/lib/settings');
    mock.method(settingsLib, 'getSettings', () => ({
      mediaActions: { providers: { anilist: true } },
    }));
    const anilist = await import('@server/lib/anilist');
    mock.method(anilist, 'getAnilistAppCredentials', () => ({
      clientId: 'id',
      clientSecret: 'secret',
    }));
    mock.method(anilist, 'getUserAnilistSettings', async () => ({
      mediaActionsAnilistEnabled: false,
    }));
    const createClient = mock.method(
      anilist,
      'createAnilistUserClient',
      async () => ({}) as never
    );

    const provider = new AnilistMediaActionProvider();
    assert.equal(await provider.isAvailable(7), false);
    assert.equal(createClient.mock.calls.length, 0);
  });

  it('isAvailable is true when the user toggle is missing and the account is linked', async () => {
    const settingsLib = await import('@server/lib/settings');
    mock.method(settingsLib, 'getSettings', () => ({
      mediaActions: { providers: { anilist: true } },
    }));
    const anilist = await import('@server/lib/anilist');
    mock.method(anilist, 'getAnilistAppCredentials', () => ({
      clientId: 'id',
      clientSecret: 'secret',
    }));
    mock.method(anilist, 'getUserAnilistSettings', async () => ({
      mediaActionsAnilistEnabled: null,
    }));
    mock.method(anilist, 'createAnilistUserClient', async () => ({}) as never);

    const provider = new AnilistMediaActionProvider();
    assert.equal(await provider.isAvailable(7), true);
  });
});
