import { assertSupportedDatabaseSchema } from '@server/lib/db/schemaGuard';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DataSource } from 'typeorm';

function stubDataSource(options: {
  knownMigrationNames: string[];
  executedMigrationNames: string[] | 'no-table';
}): DataSource {
  return {
    migrations: options.knownMigrationNames.map((name) => ({ name })),
    query: async (sql: string) => {
      if (options.executedMigrationNames === 'no-table') {
        throw new Error(`no such table: migrations (query: ${sql})`);
      }
      return options.executedMigrationNames.map((name) => ({ name }));
    },
  } as unknown as DataSource;
}

describe('assertSupportedDatabaseSchema', () => {
  it('resolves when every executed migration is recognized', async () => {
    const dataSource = stubDataSource({
      knownMigrationNames: ['InitialMigration123', 'AddThing456'],
      executedMigrationNames: ['InitialMigration123', 'AddThing456'],
    });

    await assert.doesNotReject(() => assertSupportedDatabaseSchema(dataSource));
  });

  it('resolves when the migrations table does not exist yet', async () => {
    const dataSource = stubDataSource({
      knownMigrationNames: ['InitialMigration123'],
      executedMigrationNames: 'no-table',
    });

    await assert.doesNotReject(() => assertSupportedDatabaseSchema(dataSource));
  });

  it('throws when the database was migrated by an unrecognized (newer) version', async () => {
    const dataSource = stubDataSource({
      knownMigrationNames: ['InitialMigration123', 'AddThing456'],
      executedMigrationNames: [
        'InitialMigration123',
        'AddThing456',
        'AFutureMigration999',
      ],
    });

    await assert.rejects(
      () => assertSupportedDatabaseSchema(dataSource),
      /Unsupported database schema/
    );
  });

  it('recognizes migrations that only expose their name via constructor.name', async () => {
    class DropImdbIdConstraint1607928251245 {
      // Intentionally no `name` field — matches older upstream migrations.
    }

    const dataSource = {
      migrations: [new DropImdbIdConstraint1607928251245()],
      query: async () => [{ name: 'DropImdbIdConstraint1607928251245' }],
    } as unknown as DataSource;

    await assert.doesNotReject(() => assertSupportedDatabaseSchema(dataSource));
  });

  it('resolves when Postgres reports the migrations relation is missing', async () => {
    const dataSource = {
      migrations: [{ name: 'InitialMigration123' }],
      query: async () => {
        throw Object.assign(new Error('relation "migrations" does not exist'), {
          driverError: {
            code: '42P01',
            message: 'relation "migrations" does not exist',
          },
        });
      },
    } as unknown as DataSource;

    await assert.doesNotReject(() => assertSupportedDatabaseSchema(dataSource));
  });

  it('refuses to start when the migrations table is unreadable', async () => {
    const permission = Object.assign(
      new Error('permission denied for table migrations'),
      {
        driverError: {
          code: '42501',
          message: 'permission denied for table migrations',
        },
      }
    );
    const permissionSource = {
      migrations: [{ name: 'InitialMigration123' }],
      query: async () => {
        throw permission;
      },
    } as unknown as DataSource;

    await assert.rejects(
      () => assertSupportedDatabaseSchema(permissionSource),
      permission
    );

    const connection = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    const connectionSource = {
      migrations: [{ name: 'InitialMigration123' }],
      query: async () => {
        throw connection;
      },
    } as unknown as DataSource;

    await assert.rejects(
      () => assertSupportedDatabaseSchema(connectionSource),
      connection
    );
  });
});
