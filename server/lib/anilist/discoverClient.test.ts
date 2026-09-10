import AnilistAPI from '@server/api/anilist';
import {
  AnilistNotLinkedError,
  anilistFns,
  createAnilistDiscoverClient,
} from '@server/lib/anilist';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

afterEach(() => {
  mock.restoreAll();
});

describe('createAnilistDiscoverClient', () => {
  it('uses the linked user client when the account is connected', async () => {
    const userClient = new AnilistAPI({ accessToken: 'user' });
    mock.method(anilistFns, 'createAnilistUserClient', async () => userClient);
    const client = await createAnilistDiscoverClient(1);
    assert.equal(client, userClient);
  });

  it('falls back to the app client when AniList is not linked', async () => {
    mock.method(anilistFns, 'createAnilistUserClient', async () => {
      throw new AnilistNotLinkedError();
    });
    mock.method(anilistFns, 'getAnilistAppCredentials', () => ({
      clientId: 'id',
      clientSecret: 'secret',
    }));
    const client = await createAnilistDiscoverClient(1);
    assert.ok(client instanceof AnilistAPI);
    assert.notEqual(client, undefined);
  });
});
