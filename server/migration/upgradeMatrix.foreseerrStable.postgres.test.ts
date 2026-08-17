// `DbAwareColumn` (see `@server/utils/DbColumnHelper`) reads `DB_TYPE` via
// `@server/datasource`'s `isPgsql` the first time an entity module is
// imported, baking the chosen column types into the entity metadata for the
// lifetime of this process. It must be set before any entity/datasource
// import below, which is also why this suite lives in its own test file
// instead of sharing a process with the SQLite variant.
process.env.DB_TYPE = 'postgres';

import { FORESEERR_V0_1_0_LAST_MIGRATION_TIMESTAMP } from '@server/migration/foreseerrStableBaseline';
import { loadMigrationClasses } from '@server/migration/loadMigrationClasses';
import {
  assertUpgradeIsIntact,
  ENTITIES_GLOB,
  seedBaselineFixture,
} from '@server/migration/upgradeMatrixFixture';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

describe('Upgrade matrix: Foreseerr v0.1.0 stable -> current schema (PostgreSQL)', () => {
  const host = process.env.DB_HOST;
  const username = process.env.DB_USER;
  const password = process.env.DB_PASS;
  const database = process.env.DB_NAME ?? 'foreseerr';
  const port = parseInt(process.env.DB_PORT ?? '5432', 10);

  it('preserves users, settings, requests, media, and service config across the upgrade', async (t) => {
    if (!host || !username || !password) {
      t.skip('PostgreSQL upgrade-matrix check skipped (DB env vars not set)');
      return;
    }

    const migrationsDir = join(process.cwd(), 'server/migration/postgres');
    const baseOptions: Omit<PostgresConnectionOptions, 'migrations'> = {
      type: 'postgres',
      host,
      port,
      username,
      password,
      database,
      synchronize: false,
      logging: false,
      entities: ENTITIES_GLOB,
    };

    const stableMigrations = await loadMigrationClasses(migrationsDir, {
      maxTimestamp: FORESEERR_V0_1_0_LAST_MIGRATION_TIMESTAMP,
    });
    assert.ok(
      stableMigrations.length > 0,
      'expected v0.1.0 stable migrations to be found'
    );

    // --- Phase 1: simulate a database created by Foreseerr v0.1.0. ---
    const stableDataSource = new DataSource({
      ...baseOptions,
      migrations: stableMigrations,
    });
    await stableDataSource.initialize();
    try {
      await stableDataSource.dropDatabase();
      await stableDataSource.runMigrations();
      await seedBaselineFixture(stableDataSource);
    } finally {
      await stableDataSource.destroy();
    }

    // --- Phase 2: upgrade in place to the current schema. ---
    const allMigrations = await loadMigrationClasses(migrationsDir);
    assert.ok(
      allMigrations.length >= stableMigrations.length,
      'expected current migrations to include the v0.1.0 set'
    );

    const upgradedDataSource = new DataSource({
      ...baseOptions,
      migrations: allMigrations,
    });
    await upgradedDataSource.initialize();
    try {
      await upgradedDataSource.runMigrations();
      await assertUpgradeIsIntact(upgradedDataSource);
    } finally {
      await upgradedDataSource.destroy();
    }
  });
});
