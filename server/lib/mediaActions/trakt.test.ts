import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { TraktMediaActionProvider } from './trakt';

describe('TraktMediaActionProvider isAvailable', () => {
  it('is false when the admin disables Trakt actions', async () => {
    const settingsLib = await import('@server/lib/settings');
    mock.method(settingsLib, 'getSettings', () => ({
      mediaActions: { providers: { trakt: false } },
      trakt: { provider: 'direct' },
    }));
    const trakt = await import('@server/lib/trakt');
    const createClient = mock.method(
      trakt,
      'createTraktUserClient',
      async () => ({}) as never
    );

    const provider = new TraktMediaActionProvider();
    assert.equal(await provider.isAvailable(1), false);
    assert.equal(createClient.mock.calls.length, 0);
  });

  it('is false when the user disables Trakt watch sync', async () => {
    const settingsLib = await import('@server/lib/settings');
    mock.method(settingsLib, 'getSettings', () => ({
      mediaActions: { providers: { trakt: true } },
      trakt: { provider: 'direct' },
    }));
    const trakt = await import('@server/lib/trakt');
    mock.method(trakt, 'isJellyfinTraktProvider', () => false);
    mock.method(trakt, 'getTraktAppCredentials', () => ({
      clientId: 'id',
      clientSecret: 'secret',
    }));
    mock.method(trakt, 'getUserTraktSettings', async () => ({
      mediaActionsTraktEnabled: false,
    }));
    const createClient = mock.method(
      trakt,
      'createTraktUserClient',
      async () => ({}) as never
    );

    const provider = new TraktMediaActionProvider();
    assert.equal(await provider.isAvailable(7), false);
    assert.equal(createClient.mock.calls.length, 0);
  });

  it('is true when the user toggle is missing and the account is linked', async () => {
    const settingsLib = await import('@server/lib/settings');
    mock.method(settingsLib, 'getSettings', () => ({
      mediaActions: { providers: { trakt: true } },
      trakt: { provider: 'direct' },
    }));
    const trakt = await import('@server/lib/trakt');
    mock.method(trakt, 'isJellyfinTraktProvider', () => false);
    mock.method(trakt, 'getTraktAppCredentials', () => ({
      clientId: 'id',
      clientSecret: 'secret',
    }));
    mock.method(trakt, 'getUserTraktSettings', async () => ({
      mediaActionsTraktEnabled: null,
    }));
    mock.method(trakt, 'createTraktUserClient', async () => ({}) as never);

    const provider = new TraktMediaActionProvider();
    assert.equal(await provider.isAvailable(7), true);
  });
});
