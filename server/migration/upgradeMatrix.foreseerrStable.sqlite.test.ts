import { FORESEERR_V0_1_0_LAST_MIGRATION_TIMESTAMP } from '@server/migration/foreseerrStableBaseline';
import { loadMigrationClasses } from '@server/migration/loadMigrationClasses';
import {
  assertUpgradeIsIntact,
  ENTITIES_GLOB,
  seedBaselineFixture,
} from '@server/migration/upgradeMatrixFixture';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DataSource } from 'typeorm';

describe('Upgrade matrix: Foreseerr v0.1.0 stable -> current schema (SQLite)', () => {
  it('preserves users, settings, requests, media, and service config across the upgrade', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreseerr-upgrade-stable-sqlite-'));
    const database = join(dir, 'upgrade-test.sqlite3');
    const migrationsDir = join(process.cwd(), 'server/migration/sqlite');

    const stableMigrations = await loadMigrationClasses(migrationsDir, {
      maxTimestamp: FORESEERR_V0_1_0_LAST_MIGRATION_TIMESTAMP,
    });
    assert.ok(
      stableMigrations.length > 0,
      'expected v0.1.0 stable migrations to be found'
    );

    // --- Phase 1: simulate a database created by Foreseerr v0.1.0. ---
    const stableDataSource = new DataSource({
      type: 'sqlite',
      database,
      synchronize: false,
      logging: false,
      entities: ENTITIES_GLOB,
      migrations: stableMigrations,
    });
    await stableDataSource.initialize();
    try {
      await stableDataSource.runMigrations();
      await seedBaselineFixture(stableDataSource);
    } finally {
      await stableDataSource.destroy();
    }

    // --- Phase 2: upgrade in place to the current schema. While HEAD is
    // still v0.1.0 this is a no-op migration set; later releases add
    // migrations after FORESEERR_V0_1_0_LAST_MIGRATION_TIMESTAMP. ---
    const allMigrations = await loadMigrationClasses(migrationsDir);
    assert.ok(
      allMigrations.length >= stableMigrations.length,
      'expected current migrations to include the v0.1.0 set'
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
    } finally {
      await upgradedDataSource.destroy();
    }

    rmSync(dir, { recursive: true, force: true });
  });
});
