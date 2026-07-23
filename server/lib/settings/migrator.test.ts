/**
 * Covers the settings migrator (Phase 4 persisted-settings compatibility):
 * - Loading a realistic upstream Seerr `settings.json` (no `trakt`,
 *   `mediaActions`, `mdblist`, or `metadataSettings` keys —
 *   none of those exist upstream) migrates cleanly and preserves existing
 *   user data.
 * - A `settings.json` backup is taken before migrating.
 * - A settings.json recording a migration this build doesn't recognize
 *   (i.e. written by a newer Foreseer version) is rejected with an
 *   actionable error instead of silently downgrading.
 */
import type { AllSettings } from '@server/lib/settings';
import Settings from '@server/lib/settings';
import { runMigrations } from '@server/lib/settings/migrator';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it, mock } from 'node:test';

/**
 * A settings.json shaped like what upstream Seerr (the Phase 0 baseline
 * commit) would have written: no Foreseer-only top-level keys at all, and
 * already migrated up through upstream's own last migration.
 */
function upstreamBaselineFixture(): AllSettings {
  return {
    clientId: 'legacy-client-id',
    sessionSecret: 'legacy-session-secret',
    vapidPublic: 'legacy-vapid-public',
    vapidPrivate: 'legacy-vapid-private',
    main: {
      apiKey: 'legacy-api-key',
      applicationTitle: 'My Upstream Seerr',
      applicationUrl: 'https://seerr.example.com',
      cacheImages: true,
      defaultPermissions: 2,
      defaultQuotas: { movie: {}, tv: {} },
      hideAvailable: false,
      hideBlocklisted: false,
      localLogin: true,
      mediaServerLogin: true,
      newPlexLogin: true,
      discoverRegion: 'US',
      streamingRegion: '',
      originalLanguage: '',
      blocklistRegion: '',
      blocklistLanguage: '',
      blocklistedTags: '',
      blocklistedTagsLimit: 50,
      mediaServerType: 1,
      partialRequestsEnabled: true,
      enableSpecialEpisodes: false,
      locale: 'en',
      youtubeUrl: '',
    },
    plex: {
      name: 'My Plex Server',
      ip: '10.0.0.5',
      port: 32400,
      useSsl: false,
      libraries: [{ id: '1', name: 'Movies', enabled: true, type: 'movie' }],
    },
    jellyfin: {
      name: '',
      ip: '',
      port: 8096,
      useSsl: false,
      libraries: [],
      serverId: '',
      apiKey: '',
    },
    tautulli: {},
    radarr: [],
    sonarr: [],
    public: { initialized: true },
    notifications: { agents: {} as AllSettings['notifications']['agents'] },
    jobs: {} as AllSettings['jobs'],
    network: {
      csrfProtection: false,
      forceIpv4First: false,
      trustProxy: false,
      proxy: {
        enabled: false,
        hostname: '',
        port: 8080,
        useSsl: false,
        user: '',
        password: '',
        bypassFilter: '',
        bypassLocalAddresses: true,
      },
      dnsCache: { enabled: false },
      apiRequestTimeout: 10000,
    },
    // Upstream's own migrations already ran; Foreseer-only migrations (like
    // Foreseer-specific migrations have not.
    migrations: [
      '0007_migrate_arr_tags',
      '0008_migrate_blacklist_to_blocklist',
    ],
  } as unknown as AllSettings;
}

describe('Settings migrator: upstream baseline compatibility', () => {
  const tmpDirs: string[] = [];
  after(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempSettingsPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'foreseer-settings-migrator-'));
    tmpDirs.push(dir);
    return join(dir, 'settings.json');
  }

  it('migrates an upstream-shaped settings.json and preserves existing data', async () => {
    const settingsPath = tempSettingsPath();
    const fixture = upstreamBaselineFixture();

    const migrated = await runMigrations(fixture, settingsPath);

    // Historical request-routing migrations run in order, then remove the
    // retired setting from the current schema.
    assert.ok(
      migrated.migrations.includes('0009_migrate_request_routing_settings')
    );
    assert.ok(
      migrated.migrations.includes('0010_remove_request_routing_settings')
    );
    assert.equal(
      (migrated as unknown as { requestRouting?: unknown }).requestRouting,
      undefined
    );
    assert.equal(
      (migrated as unknown as { requestFilters?: unknown }).requestFilters,
      undefined
    );

    // Unrelated existing user data survives untouched.
    assert.equal(migrated.main.applicationTitle, 'My Upstream Seerr');
    assert.equal(migrated.main.apiKey, 'legacy-api-key');
    assert.equal(migrated.plex.ip, '10.0.0.5');
    assert.equal(migrated.plex.libraries.length, 1);
    assert.equal(migrated.clientId, 'legacy-client-id');

    // A backup of the pre-migration file was written before mutating.
    const backupPath = settingsPath.replace('.json', '.old.json');
    const backupContents = JSON.parse(await fs.readFile(backupPath, 'utf-8'));
    assert.deepEqual(backupContents, fixture);

    // The migrated result was persisted to the settings path.
    const savedContents = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));
    assert.deepEqual(savedContents, migrated);

    // End-to-end: feeding the migrated (still Foreseer-key-less at the
    // migrator level) result through the real Settings class backfills
    // Foreseer-only fields (trakt/mediaActions/mdblist) with safe defaults
    // via constructor merge + getters, without clobbering existing data.
    const settings = new Settings(migrated);
    assert.deepEqual(settings.trakt, { clientId: '', clientSecret: '' });
    assert.deepEqual(settings.mediaActions, { providers: { trakt: true } });
    assert.equal(settings.mdblist.apiKey, '');
    assert.equal(settings.main.applicationTitle, 'My Upstream Seerr');
    assert.equal(settings.plex.ip, '10.0.0.5');
  });

  it('rejects a settings.json written by a newer, unrecognized Foreseer version', async () => {
    const settingsPath = tempSettingsPath();
    const fixture = {
      ...upstreamBaselineFixture(),
      migrations: [
        '0007_migrate_arr_tags',
        '0008_migrate_blacklist_to_blocklist',
        '0009_migrate_request_routing_settings',
        '0099_a_future_migration_from_a_newer_foreseer',
      ],
    };

    class ProcessExitCalled extends Error {
      constructor(public code: number | undefined) {
        super(`process.exit(${code}) called`);
      }
    }
    const exitMock = mock.method(process, 'exit', ((code?: number): never => {
      throw new ProcessExitCalled(code);
    }) as unknown as typeof process.exit);

    try {
      await assert.rejects(
        () => runMigrations(fixture, settingsPath),
        (err: unknown) => {
          assert.ok(err instanceof ProcessExitCalled);
          assert.equal(err.code, 1);
          return true;
        }
      );

      // No backup or write should have happened before the bail-out.
      await assert.rejects(() => fs.readFile(settingsPath, 'utf-8'));
      await assert.rejects(() =>
        fs.readFile(settingsPath.replace('.json', '.old.json'), 'utf-8')
      );
    } finally {
      exitMock.mock.restore();
    }
  });
});
