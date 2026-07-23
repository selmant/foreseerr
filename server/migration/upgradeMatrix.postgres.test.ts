// `DbAwareColumn` (see `@server/utils/DbColumnHelper`) reads `DB_TYPE` via
// `@server/datasource`'s `isPgsql` the first time an entity module is
// imported, baking the chosen column types into the entity metadata for the
// lifetime of this process. It must be set before any entity/datasource
// import below, which is also why this suite lives in its own test file
// instead of sharing a process with the SQLite variant.
process.env.DB_TYPE = 'postgres';

import { loadMigrationClasses } from '@server/migration/loadMigrationClasses';
import {
  assertUpgradeIsIntact,
  ENTITIES_GLOB,
  seedBaselineFixture,
} from '@server/migration/upgradeMatrixFixture';
import { UPSTREAM_BASELINE_LAST_SHARED_MIGRATION_TIMESTAMP } from '@server/migration/upstreamBaseline';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

describe('Upgrade matrix: upstream Seerr baseline -> current schema (PostgreSQL)', () => {
  const host = process.env.DB_HOST;
  const username = process.env.DB_USER;
  const password = process.env.DB_PASS;
  const database = process.env.DB_NAME ?? 'foreseer';
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
      ...baseOptions,
      migrations: baselineMigrations,
    });
    await baselineDataSource.initialize();
    try {
      // Start from a clean schema so re-runs of this test locally don't
      // collide with leftover tables from a previous run.
      await baselineDataSource.dropDatabase();
      await baselineDataSource.runMigrations();
      await seedBaselineFixture(baselineDataSource);
    } finally {
      await baselineDataSource.destroy();
    }

    // --- Phase 2: upgrade the same database in place to the current schema
    // by replaying the remaining (Foreseer-only) migrations. ---
    const allMigrations = await loadMigrationClasses(migrationsDir);
    const upgradedDataSource = new DataSource({
      ...baseOptions,
      migrations: allMigrations,
    });
    await upgradedDataSource.initialize();
    try {
      await upgradedDataSource.runMigrations();
      await assertUpgradeIsIntact(upgradedDataSource);

      // --- Structural checks: indexes, unique constraints, foreign keys ---
      const traktUserIdIndex = await upgradedDataSource.query(
        `SELECT indexname FROM pg_indexes WHERE indexname = 'UQ_user_settings_traktUserId'`
      );
      assert.equal(
        traktUserIdIndex.length,
        1,
        'unique partial index on traktUserId should exist after upgrade'
      );

      const mediaRequestForeignKeys = await upgradedDataSource.query(`
        SELECT confrelid::regclass::text AS referenced_table
        FROM pg_constraint
        WHERE conrelid = 'media_request'::regclass AND contype = 'f'
      `);
      const referencedTables = mediaRequestForeignKeys.map(
        (fk: { referenced_table: string }) => fk.referenced_table
      );
      assert.ok(referencedTables.includes('media'));
      assert.ok(
        referencedTables.includes('user') || referencedTables.includes('"user"')
      );
    } finally {
      await upgradedDataSource.destroy();
    }
  });
});
