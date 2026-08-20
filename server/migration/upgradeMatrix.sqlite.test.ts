import { loadMigrationClasses } from '@server/migration/loadMigrationClasses';
import {
  assertUpgradeIsIntact,
  ENTITIES_GLOB,
  seedBaselineFixture,
} from '@server/migration/upgradeMatrixFixture';
import { UPSTREAM_BASELINE_LAST_SHARED_MIGRATION_TIMESTAMP } from '@server/migration/upstreamBaseline';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DataSource } from 'typeorm';

describe('Upgrade matrix: upstream Seerr baseline -> current schema (SQLite)', () => {
  it('preserves users, settings, requests, media, and service config across the upgrade', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreseerr-upgrade-sqlite-'));
    const database = join(dir, 'upgrade-test.sqlite3');
    const migrationsDir = join(process.cwd(), 'server/migration/sqlite');

    const baselineMigrations = await loadMigrationClasses(migrationsDir, {
      maxTimestamp: UPSTREAM_BASELINE_LAST_SHARED_MIGRATION_TIMESTAMP,
    });
    assert.ok(
      baselineMigrations.length > 0,
      'expected baseline migrations to be found'
    );

    // --- Phase 1: simulate a database created by upstream Seerr at the
    // baseline commit, using only the migrations that existed then. ---
    const baselineDataSource = new DataSource({
      type: 'sqlite',
      database,
      synchronize: false,
      logging: false,
      entities: ENTITIES_GLOB,
      migrations: baselineMigrations,
    });
    await baselineDataSource.initialize();
    try {
      await baselineDataSource.runMigrations();
      await seedBaselineFixture(baselineDataSource);
    } finally {
      await baselineDataSource.destroy();
    }

    // --- Phase 2: upgrade the same physical file in place to the current
    // schema by replaying the remaining (Foreseerr-only) migrations. ---
    const allMigrations = await loadMigrationClasses(migrationsDir);
    assert.ok(
      allMigrations.length > baselineMigrations.length,
      'expected Foreseerr-only migrations on top of the baseline set'
    );

    const upgradedDataSource = new DataSource({
      type: 'sqlite',
      database,
      synchronize: false,
      logging: false,
      entities: ENTITIES_GLOB,
      migrations: allMigrations,
    });
    await upgradedDataSource.initialize();
    try {
      await upgradedDataSource.runMigrations();
      await assertUpgradeIsIntact(upgradedDataSource);

      // --- Structural checks: indexes, unique constraints, foreign keys ---
      const traktUserIdIndex = await upgradedDataSource.query(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'UQ_user_settings_traktUserId'`
      );
      assert.equal(
        traktUserIdIndex.length,
        1,
        'unique partial index on traktUserId should exist after upgrade'
      );

      const ongoingEpisodeRequestIndex = await upgradedDataSource.query(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'IDX_media_request_active_ongoing_episode'`
      );
      assert.equal(
        ongoingEpisodeRequestIndex.length,
        1,
        'unique partial index on active ongoing episode requests should exist after upgrade'
      );

      const mediaRequestForeignKeys: { table: string }[] =
        await upgradedDataSource.query(
          `PRAGMA foreign_key_list('media_request')`
        );
      const referencedTables = mediaRequestForeignKeys.map((fk) => fk.table);
      assert.ok(referencedTables.includes('media'));
      assert.ok(referencedTables.includes('user'));

      const mediaRequestIndexes = await upgradedDataSource.query(
        `PRAGMA index_list('media_request')`
      );
      assert.ok(
        mediaRequestIndexes.length > 0,
        'media_request should retain its indexes after upgrade'
      );
    } finally {
      await upgradedDataSource.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
