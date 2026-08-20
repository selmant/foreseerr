import * as anilist from '@server/lib/anilist';
import { AnilistNotLinkedError } from '@server/lib/anilist';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { getAnilistUserContext } from './userContext';

afterEach(() => mock.restoreAll());

describe('getAnilistUserContext', () => {
  it('returns one client and validated remote user identity', async () => {
    const client = { marker: 'client' };
    mock.method(
      anilist,
      'createAnilistUserClient',
      async () => client as never
    );
    mock.method(anilist, 'getUserAnilistSettings', async () => ({
      anilistUserId: 42,
    }));

    assert.deepEqual(await getAnilistUserContext(7), {
      client,
      anilistUserId: 42,
    });
  });

  it('rejects missing or invalid remote identity', async () => {
    mock.method(anilist, 'createAnilistUserClient', async () => ({}) as never);
    mock.method(anilist, 'getUserAnilistSettings', async () => ({
      anilistUserId: 'not-a-number',
    }));

    await assert.rejects(getAnilistUserContext(7), AnilistNotLinkedError);
  });
});
