import AnilistAPI from '@server/api/anilist';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import {
  AnilistNotLinkedError,
  anilistFns,
  createAnilistDiscoverClient,
  createAnilistUserClient,
} from '@server/lib/anilist';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

afterEach(() => {
  mock.restoreAll();
});

setupTestDb();

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

describe('createAnilistUserClient', () => {
  /** Links the admin with `token`; the client reads `read` instead. */
  const link = async (token: string, read: string) => {
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    const repository = getRepository(UserSettings);
    const settings =
      (await repository.findOne({ where: { user: { id: user.id } } })) ??
      repository.create({ user: { id: user.id } });
    Object.assign(settings, {
      anilistAccessToken: token,
      anilistTokenExpiresAt: '100',
      anilistUserId: '42',
    });
    await repository.save(settings);
    mock.method(anilistFns, 'getAnilistAppCredentials', () => ({
      clientId: 'id',
      clientSecret: 'secret',
    }));
    mock.method(anilistFns, 'getUserAnilistSettings', async () => ({
      ...settings,
      anilistAccessToken: read,
    }));
    await assert.rejects(
      createAnilistUserClient(user.id),
      AnilistNotLinkedError
    );
    return repository
      .createQueryBuilder('settings')
      .addSelect('settings.anilistAccessToken')
      .where('settings.id = :id', { id: settings.id })
      .getOneOrFail();
  };

  it('clears an expired link', async () => {
    const stored = await link('expired', 'expired');
    assert.equal(stored.anilistAccessToken, null);
    assert.equal(stored.anilistUserId, null);
  });

  it('keeps a link made after the expired token was read', async () => {
    const stored = await link('relinked', 'expired');
    assert.equal(stored.anilistAccessToken, 'relinked');
    assert.equal(stored.anilistUserId, '42');
  });
});
