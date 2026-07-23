/**
 * Fresh-install migration smoke test for SQLite and, when configured,
 * PostgreSQL.
 *
 * SQLite and PostgreSQL checks must run in separate OS processes, not just
 * separate functions within one process: `DbAwareColumn` (see
 * `@server/utils/DbColumnHelper`) reads `DB_TYPE` via `@server/datasource`'s
 * `isPgsql` flag the first time an entity module is imported (e.g. when a
 * DataSource resolves its entities glob), and bakes that choice into the
 * entity's column types for the lifetime of the process. Running both
 * checks back-to-back in one process previously caused the PostgreSQL check
 * to silently reuse SQLite-flavored column types (e.g. `datetime` instead of
 * `timestamp with time zone`), which TypeORM then rejects as unsupported.
 *
 * `pnpm check:migrations` therefore invokes this script twice, once per
 * engine, each in its own process (see the `check:migrations` script in
 * package.json).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';

const ENTITIES_GLOB = ['server/entity/**/*.ts'];

async function runMigrations(
  label: string,
  options: ConstructorParameters<typeof DataSource>[0]
): Promise<DataSource> {
  const dataSource = new DataSource(options);
  await dataSource.initialize();
  await dataSource.runMigrations();
  console.log(`${label} migrations OK`);
  return dataSource;
}

/**
 * Checks that important indexes, unique constraints, and foreign keys exist
 * after a fresh-install migration run — not just that the migration runner
 * exited successfully.
 */
async function assertSchemaInvariants(
  label: string,
  dataSource: DataSource
): Promise<void> {
  const isPostgres = dataSource.options.type === 'postgres';

  const traktUserIdIndex = isPostgres
    ? await dataSource.query(
        `SELECT indexname FROM pg_indexes WHERE indexname = 'UQ_user_settings_traktUserId'`
      )
    : await dataSource.query(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'UQ_user_settings_traktUserId'`
      );
  if (traktUserIdIndex.length !== 1) {
    throw new Error(
      `${label}: expected unique index UQ_user_settings_traktUserId on user_settings after a fresh install`
    );
  }

  const mediaRequestForeignKeyCount = isPostgres
    ? (
        await dataSource.query(`
          SELECT count(*)::int AS count
          FROM pg_constraint
          WHERE conrelid = 'media_request'::regclass AND contype = 'f'
        `)
      )[0].count
    : (await dataSource.query(`PRAGMA foreign_key_list('media_request')`))
        .length;
  if (mediaRequestForeignKeyCount < 2) {
    throw new Error(
      `${label}: expected media_request to have foreign keys to media and user after a fresh install`
    );
  }

  console.log(`${label} schema invariants OK`);
}

async function checkSqliteMigrations(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'foreseerr-sqlite-migration-'));
  const database = join(dir, 'migration-test.sqlite3');

  const dataSource = await runMigrations('SQLite', {
    type: 'sqlite',
    database,
    synchronize: false,
    logging: false,
    entities: ENTITIES_GLOB,
    migrations: ['server/migration/sqlite/**/*.ts'],
  });

  try {
    await assertSchemaInvariants('SQLite', dataSource);
  } finally {
    await dataSource.destroy();
  }
}

async function checkPostgresMigrations(): Promise<void> {
  const host = process.env.DB_HOST;
  const username = process.env.DB_USER;
  const password = process.env.DB_PASS;
  const database = process.env.DB_NAME ?? 'foreseerr';

  if (!host || !username || !password) {
    console.log('PostgreSQL migration check skipped (DB env vars not set)');
    return;
  }

  const dataSource = await runMigrations('PostgreSQL', {
    type: 'postgres',
    host,
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    username,
    password,
    database,
    synchronize: false,
    logging: false,
    entities: ENTITIES_GLOB,
    migrations: ['server/migration/postgres/**/*.ts'],
  });

  try {
    await assertSchemaInvariants('PostgreSQL', dataSource);
  } finally {
    await dataSource.destroy();
  }
}

async function main(): Promise<void> {
  const engine = process.argv[2];

  if (engine === 'postgres') {
    await checkPostgresMigrations();
  } else if (engine === 'sqlite' || engine === undefined) {
    await checkSqliteMigrations();
  } else {
    throw new Error(
      `Unknown engine argument "${engine}". Expected "sqlite" or "postgres".`
    );
  }
}

main().catch((error: unknown) => {
  console.error('migration check failed:', error);
  process.exit(1);
});
