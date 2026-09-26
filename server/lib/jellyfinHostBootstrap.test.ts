import { MediaServerType } from '@server/constants/server';
import {
  applyJellyfinHostFile,
  pluginAdminPermissions,
} from '@server/lib/jellyfinHostBootstrap';
import { Permission } from '@server/lib/permissions';
import { getSettings, resetSettings } from '@server/lib/settings';
import { getHostname, getJellyfinLinkHost } from '@server/utils/getHostname';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('applyJellyfinHostFile', () => {
  // Other suites share the settings singleton; start from defaults.
  beforeEach(() => {
    resetSettings();
  });
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

  it('preserves disabled libraries and imports a Jellyfin subpath', () => {
    const settings = getSettings();
    settings.jellyfin.libraries = [
      { id: 'lib-1', name: 'Movies', type: 'movie', enabled: false },
    ];
    applyJellyfinHostFile({
      jellyfin: {
        urlBase: '/jellyfin',
        libraries: [
          { id: 'lib-1', name: 'Movies', type: 'movie', enabled: true },
        ],
      },
    });
    assert.equal(settings.jellyfin.urlBase, '/jellyfin');
    assert.equal(settings.jellyfin.libraries[0].enabled, false);
  });

  it('keeps saved libraries when the plugin could not list them', () => {
    const settings = getSettings();
    settings.jellyfin.libraries = [
      {
        id: 'lib-1',
        name: 'Movies',
        type: 'movie',
        enabled: false,
        lastScan: 9,
      },
    ];
    applyJellyfinHostFile({ jellyfin: { apiKey: 'k', libraries: null } });
    assert.deepEqual(settings.jellyfin.libraries, [
      {
        id: 'lib-1',
        name: 'Movies',
        type: 'movie',
        enabled: false,
        lastScan: 9,
      },
    ]);
  });

  it('only defaults Trakt to Better Trakt when no Trakt app is configured', () => {
    const settings = getSettings();
    settings.trakt = { provider: 'direct', clientId: 'id', clientSecret: 's' };
    applyJellyfinHostFile({ trakt: { provider: 'jellyfin' } });
    assert.equal(settings.trakt.provider, 'direct');
  });

  it('keeps URLs entered in Foreseerr when the plugin page has none', () => {
    const settings = getSettings();
    settings.main.applicationUrl = 'https://own.example.com';
    settings.jellyfin.externalHostname = 'https://media.example.com';
    applyJellyfinHostFile({
      main: { applicationUrl: '' },
      jellyfin: { externalHostname: '' },
    });
    assert.equal(settings.main.applicationUrl, 'https://own.example.com');
    assert.equal(
      settings.jellyfin.externalHostname,
      'https://media.example.com'
    );
  });

  it('clears URLs the plugin set once its page is cleared', () => {
    const settings = getSettings();
    settings.main.applicationUrl = 'https://own.example.com';
    // The plugin page wins while it has a value.
    applyJellyfinHostFile({
      main: { applicationUrl: 'https://jf.example.com/Foreseerr' },
      jellyfin: { externalHostname: 'https://jf.example.com' },
    });
    assert.equal(
      settings.main.applicationUrl,
      'https://jf.example.com/Foreseerr'
    );
    assert.equal(settings.jellyfin.externalHostname, 'https://jf.example.com');
    applyJellyfinHostFile({
      main: { applicationUrl: '' },
      jellyfin: { externalHostname: '' },
    });
    assert.equal(settings.main.applicationUrl, '');
    assert.equal(settings.jellyfin.externalHostname, '');
  });

  it('removes only an ADMIN permission the plugin granted', () => {
    const defaults = Permission.REQUEST;
    const { ADMIN, AUTO_APPROVE, MANAGE_REQUESTS } = Permission;
    assert.deepEqual(
      pluginAdminPermissions(AUTO_APPROVE, true, false, defaults),
      {
        permissions: AUTO_APPROVE | ADMIN,
        grantedByPlugin: true,
      }
    );
    // Already an admin in Foreseerr: nothing to grant or record.
    assert.deepEqual(pluginAdminPermissions(ADMIN, true, false, defaults), {
      permissions: ADMIN,
      grantedByPlugin: false,
    });
    assert.deepEqual(
      pluginAdminPermissions(AUTO_APPROVE | ADMIN, false, true, defaults),
      { permissions: AUTO_APPROVE, grantedByPlugin: false }
    );
    assert.deepEqual(pluginAdminPermissions(ADMIN, false, true, defaults), {
      permissions: defaults,
      grantedByPlugin: false,
    });
    assert.deepEqual(pluginAdminPermissions(ADMIN, false, false, defaults), {
      permissions: ADMIN,
      grantedByPlugin: false,
    });
    // ADMIN already removed in Foreseerr: keep what the admin chose.
    assert.deepEqual(pluginAdminPermissions(0, false, true, defaults), {
      permissions: 0,
      grantedByPlugin: false,
    });
    assert.deepEqual(
      pluginAdminPermissions(MANAGE_REQUESTS, false, false, defaults),
      { permissions: MANAGE_REQUESTS, grantedByPlugin: false }
    );
  });

  it('links to Jellyfin on the same origin in plugin mode without a public URL', () => {
    const previous = process.env.FORESEERR_PLUGIN;
    const settings = getSettings();
    settings.jellyfin.ip = '127.0.0.1';
    settings.jellyfin.port = 8096;
    settings.jellyfin.urlBase = '/jellyfin';
    settings.jellyfin.externalHostname = '';
    try {
      process.env.FORESEERR_PLUGIN = '1';
      assert.equal(getJellyfinLinkHost(), '/jellyfin');
      settings.jellyfin.externalHostname = 'https://media.example.com/jellyfin';
      assert.equal(getJellyfinLinkHost(), 'https://media.example.com/jellyfin');
      delete process.env.FORESEERR_PLUGIN;
      settings.jellyfin.externalHostname = '';
      assert.equal(getJellyfinLinkHost(), getHostname());
    } finally {
      if (previous === undefined) delete process.env.FORESEERR_PLUGIN;
      else process.env.FORESEERR_PLUGIN = previous;
    }
  });
});
