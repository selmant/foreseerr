// Generate backend-rs/src/dbmigrate/{sqlite,postgres}.rs from the TypeORM
// migrations in server/migration, plus the SQLite schema reference the Rust
// test compares against.
//
// Every migration's `up()` is run against a recording QueryRunner, so the
// generated list holds exactly the statements TypeORM sends, in order. SQLite
// migrations run on a real temporary database: `DropImdbIdConstraint` uses
// `queryRunner.dropUniqueConstraint`, whose table rebuild TypeORM derives from
// the live schema. PostgreSQL migrations only call `queryRunner.query` with
// literal SQL, so a runner that records without executing is enough; any
// other call fails the script.
//
// The reference schema comes from TypeORM's own `dataSource.runMigrations()`
// with the same migration glob and PRAGMAs as server/index.ts in production.
//
// Run from the repository (mise picks the bun the server uses there):
//   cd <repo> && bun <crate>/scripts/gen-migrations.ts <repo> <crate>
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [repo, crate] = process.argv.slice(2);
if (!repo || !crate) {
  throw new Error('usage: gen-migrations.ts <repo> <crate>');
}
const requireFromRepo = createRequire(join(repo, 'package.json'));
const { DataSource } = requireFromRepo('typeorm');
const { bunSqlite3 } = await import(join(repo, 'server/lib/bunSqlite3.ts'));

type Recorded = { timestamp: number; name: string; queries: string[] };

// An integer literal with `_` every three digits (clippy's unreadable_literal).
const rustInt = (n: number): string =>
  String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '_');
type Instance = { name?: string; up(runner: unknown): Promise<void> };

async function load(dialect: string): Promise<Instance[]> {
  const dir = join(repo, 'server/migration', dialect);
  const files = readdirSync(dir)
    .filter((f) => /^\d+-.+\.ts$/.test(f) && !f.includes('.test.'))
    .sort();
  const instances: Instance[] = [];
  for (const file of files) {
    const mod = await import(join(dir, file));
    const cls = Object.values(mod).find((v) => typeof v === 'function') as
      | (new () => Instance)
      | undefined;
    if (!cls) throw new Error(`no migration class in ${file}`);
    instances.push(new cls());
  }
  return instances;
}

// TypeORM's MigrationExecutor.getMigrations(): `name` or the class name,
// timestamp from its last 13 characters, stable sort by timestamp.
function ordered(instances: Instance[]) {
  return instances
    .map((instance) => {
      const name = instance.name || instance.constructor.name;
      const timestamp = parseInt(name.substr(-13), 10);
      if (!timestamp) throw new Error(`bad migration name ${name}`);
      return { instance, name, timestamp };
    })
    .sort((a, b) => a.timestamp - b.timestamp);
}

function noParams(sql: string, params: unknown) {
  if (Array.isArray(params) && params.length > 0) {
    throw new Error(`parameters are not supported: ${sql}`);
  }
}

async function recordSqlite(): Promise<Recorded[]> {
  const dir = mkdtempSync(join(tmpdir(), 'gen-migrations-'));
  const ds = new DataSource({
    type: 'sqlite',
    driver: bunSqlite3,
    database: join(dir, 'db.sqlite3'),
    synchronize: false,
    migrations: [],
    entities: [],
  });
  await ds.initialize();
  await ds.query('PRAGMA foreign_keys=OFF');
  const out: Recorded[] = [];
  for (const { instance, name, timestamp } of ordered(await load('sqlite'))) {
    const queries: string[] = [];
    const runner = ds.createQueryRunner();
    const realQuery = runner.query.bind(runner);
    runner.executeQueries = async (
      up: { query: string; parameters?: unknown }[]
    ) => {
      for (const q of up) {
        noParams(q.query, q.parameters);
        queries.push(q.query);
        await realQuery(q.query, q.parameters);
      }
    };
    const recording = new Proxy(runner, {
      get(target, prop) {
        if (prop === 'query') {
          return async (sql: string, params?: unknown) => {
            noParams(sql, params);
            queries.push(sql);
            return realQuery(sql, params);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await instance.up(recording);
    await runner.release();
    out.push({ timestamp, name, queries });
  }
  await ds.destroy();
  rmSync(dir, { recursive: true, force: true });
  return out;
}

async function recordPostgres(): Promise<Recorded[]> {
  const out: Recorded[] = [];
  for (const { instance, name, timestamp } of ordered(await load('postgres'))) {
    const queries: string[] = [];
    const runner = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'query') {
            return async (sql: string, params?: unknown) => {
              noParams(sql, params);
              queries.push(sql);
              return [];
            };
          }
          throw new Error(`${name} uses queryRunner.${String(prop)}`);
        },
      }
    );
    await instance.up(runner);
    out.push({ timestamp, name, queries });
  }
  return out;
}

// What TypeORM's `createTable` writes for the migrations table.
function migrationsTableSql(type: 'sqlite' | 'postgres'): string {
  const ds = new DataSource({
    type,
    driver: type === 'sqlite' ? bunSqlite3 : undefined,
  });
  const runner = ds.driver.createQueryRunner('master');
  const { Table } = requireFromRepo('typeorm');
  const mapped = ds.driver.mappedDataTypes;
  const table = new Table({
    name: 'migrations',
    columns: [
      {
        name: 'id',
        type: ds.driver.normalizeType({ type: mapped.migrationId }),
        isGenerated: true,
        generationStrategy: 'increment',
        isPrimary: true,
        isNullable: false,
      },
      {
        name: 'timestamp',
        type: ds.driver.normalizeType({ type: mapped.migrationTimestamp }),
        isPrimary: false,
        isNullable: false,
      },
      {
        name: 'name',
        type: ds.driver.normalizeType({ type: mapped.migrationName }),
        isNullable: false,
      },
    ],
  });
  return runner.createTableSql(table, false).query;
}

function rustString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function render(
  dialect: string,
  table: string,
  migrations: Recorded[]
): string {
  const lines = [
    `//! The ${dialect} migrations in \`server/migration/${dialect}\`, in the`,
    '//! order `TypeORM` runs them, with the statements each `up()` sends.',
    '//! Generated by `scripts/gen-migrations.ts`; do not edit.',
    '',
    'use super::Migration;',
    '',
    '/// `CREATE TABLE "migrations"` as `TypeORM` writes it.',
    `pub(super) const MIGRATIONS_TABLE: &str = ${rustString(table)};`,
    '',
    '/// Every migration, oldest first.',
    'pub(super) const MIGRATIONS: &[Migration] = &[',
  ];
  for (const m of migrations) {
    lines.push('    Migration {');
    lines.push(`        timestamp: ${rustInt(m.timestamp)},`);
    lines.push(`        name: ${rustString(m.name)},`);
    lines.push('        queries: &[');
    for (const q of m.queries) lines.push(`            ${rustString(q)},`);
    lines.push('        ],');
    lines.push('    },');
  }
  lines.push('];', '');
  return lines.join('\n');
}

// The schema TypeORM's own runner leaves behind, for the Rust test.
async function reference(): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'gen-migrations-ref-'));
  const cwd = process.cwd();
  process.chdir(repo);
  const ds = new DataSource({
    type: 'sqlite',
    driver: bunSqlite3,
    database: join(dir, 'db.sqlite3'),
    synchronize: false,
    migrationsRun: false,
    enableWAL: true,
    migrations: ['server/migration/sqlite/**/*.ts'],
    entities: [],
  });
  await ds.initialize();
  await ds.query('PRAGMA foreign_keys=OFF');
  await ds.runMigrations();
  await ds.query('PRAGMA foreign_keys=ON');
  const schema = await ds.query(
    `SELECT "type", "name", "tbl_name", "sql" FROM sqlite_master WHERE "name" NOT LIKE 'sqlite_%' ORDER BY "type", "name"`
  );
  const migrations = await ds.query(
    `SELECT "id", "timestamp", "name" FROM "migrations" ORDER BY "id"`
  );
  await ds.destroy();
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
  return { schema, migrations };
}

// server/lib/overseerrMerge.ts keeps its SeerrMigration class private, so
// its statements are read from the source: every one is a template literal
// without placeholders.
function seerrMigration(): string {
  const text = readFileSync(join(repo, 'server/lib/overseerrMerge.ts'), 'utf8');
  const start = text.indexOf('class SeerrMigration1759769291608');
  const up = text.indexOf('public async up(', start);
  const down = text.indexOf('public async down(', up);
  if (start < 0 || up < 0 || down < 0)
    throw new Error('SeerrMigration not found');
  const body = text.slice(up, down);
  const queries = [
    ...body.matchAll(/queryRunner\.query\(\s*`([^`]*)`\s*\)/g),
  ].map((m) => m[1]);
  const calls = body.split('queryRunner.').length - 1;
  if (queries.length !== calls || queries.some((q) => q.includes('${'))) {
    throw new Error('SeerrMigration has statements this script cannot read');
  }
  const lines = [
    '',
    '/// `SeerrMigration1759769291608` from `server/lib/overseerrMerge.ts`,',
    '/// which replaces `UpdateWebPush1745492372230` for an Overseerr database.',
    'pub(super) const SEERR_MIGRATION: Migration = Migration {',
    '    timestamp: 1_759_769_291_608,',
    '    name: "SeerrMigration1759769291608",',
    '    queries: &[',
    ...queries.map((q) => `        ${rustString(q)},`),
    '    ],',
    '};',
    '',
  ];
  return lines.join('\n');
}

const out = join(crate, 'src/dbmigrate');
writeFileSync(
  join(out, 'sqlite.rs'),
  render('sqlite', migrationsTableSql('sqlite'), await recordSqlite()) +
    seerrMigration()
);
writeFileSync(
  join(out, 'postgres.rs'),
  render('postgres', migrationsTableSql('postgres'), await recordPostgres())
);
writeFileSync(
  join(out, 'sqlite_reference.json'),
  JSON.stringify(await reference(), undefined, 2) + '\n'
);
