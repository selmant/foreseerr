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
});
