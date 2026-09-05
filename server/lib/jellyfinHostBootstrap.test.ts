import { MediaServerType } from '@server/constants/server';
import {
  applyJellyfinHostFile,
  jellyfinUserIdCandidates,
} from '@server/lib/jellyfinHostBootstrap';
import { getSettings, resetSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

describe('applyJellyfinHostFile', () => {
  afterEach(() => {
    resetSettings();
  });

  it('merges managed Jellyfin keys without touching radarr or sonarr', () => {
    const settings = getSettings();
    settings.radarr = [
      {
        id: 1,
        name: 'Radarr',
        hostname: '127.0.0.1',
        port: 7878,
        apiKey: 'keep-me',
        useSsl: false,
        activeProfileId: 1,
        activeProfileName: 'Any',
        activeDirectory: '/movies',
        is4k: false,
        isDefault: true,
        syncEnabled: true,
        preventSearch: false,
        tagRequests: false,
        tags: [],
        overrideRule: [],
        minimumAvailability: 'Released',
      },
    ];
    applyJellyfinHostFile({
      main: {
        applicationUrl: 'https://jellyfin.example.com/Foreseerr',
        locale: 'de',
        localLogin: false,
      },
      jellyfin: {
        name: 'Home',
        ip: '127.0.0.1',
        port: 8096,
        useSsl: false,
        urlBase: '',
        externalHostname: 'https://jellyfin.example.com',
        serverId: 'server-1',
        apiKey: 'jf-key',
        libraries: [
          { id: 'lib-1', name: 'Movies', type: 'movie', enabled: true },
        ],
      },
      trakt: { provider: 'jellyfin' },
      mdblist: { apiKey: 'mdb-key' },
    });

    assert.equal(settings.main.mediaServerType, MediaServerType.JELLYFIN);
    assert.equal(settings.main.localLogin, false);
    assert.equal(
      settings.main.applicationUrl,
      'https://jellyfin.example.com/Foreseerr'
    );
    assert.equal(settings.jellyfin.apiKey, 'jf-key');
    assert.equal(settings.jellyfin.libraries[0]?.id, 'lib-1');
    assert.equal(settings.trakt.provider, 'jellyfin');
    assert.equal(settings.mdblist.apiKey, 'mdb-key');
    assert.equal(settings.public.initialized, true);
    assert.equal(settings.radarr[0]?.apiKey, 'keep-me');
    assert.deepEqual(settings.sonarr, []);
  });

  it('preserves lastScan when re-merging the same library id', () => {
    const settings = getSettings();
    settings.jellyfin.libraries = [
      {
        id: 'lib-1',
        name: 'Movies',
        type: 'movie',
        enabled: true,
        lastScan: 9,
      },
    ];
    applyJellyfinHostFile({
      jellyfin: {
        apiKey: 'k',
        libraries: [{ id: 'lib-1', name: 'Movies', type: 'movie' }],
      },
    });
    assert.equal(settings.jellyfin.libraries[0]?.lastScan, 9);
  });

  it('enables a managed ForeseerrPlugin webhook without wiping radarr', () => {
    const settings = getSettings();
    applyJellyfinHostFile({
      jellyfin: { apiKey: 'k' },
      webhook: {
        url: 'http://127.0.0.1:8096/ForeseerrPlugin/Webhook',
        secret: 'whsec',
      },
    });
    assert.equal(settings.notifications.agents.webhook.enabled, true);
    assert.equal(settings.notifications.agents.webhook.types, 3918);
    assert.equal(
      settings.notifications.agents.webhook.options.webhookUrl,
      'http://127.0.0.1:8096/ForeseerrPlugin/Webhook'
    );
    assert.equal(
      settings.notifications.agents.webhook.options.authHeader,
      'Bearer whsec'
    );
  });

  it('normalizes dashed and compact Jellyfin user ids', () => {
    const dashed = 'a7c3e2f1-9b4d-4e8a-8c1f-2b6d9e0f4a11';
    const compact = dashed.replace(/-/g, '');
    const ids = jellyfinUserIdCandidates(compact);
    assert.ok(ids.includes(dashed));
    assert.ok(ids.includes(compact));
  });
});
