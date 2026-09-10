import { bunSqlite3 } from '@server/lib/bunSqlite3';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { DataSource } from 'typeorm';

import { RemapDiscoverSliderTypes1787510000000 } from './sqlite/1787510000000-RemapDiscoverSliderTypes';

const dataSource = new DataSource({
  type: 'sqlite',
  driver: bunSqlite3,
  database: ':memory:',
});

after(async () => {
  if (dataSource.isInitialized) {
    await dataSource.destroy();
  }
});

describe('RemapDiscoverSliderTypes (SQLite)', () => {
  it('shifts leftover Foreseer types 22+ to 1001+ and leaves upstream types alone', async () => {
    await dataSource.initialize();
    await dataSource.query(
      `CREATE TABLE "discover_slider" ("id" integer PRIMARY KEY, "type" integer NOT NULL)`
    );
    await dataSource.query(
      `INSERT INTO "discover_slider" ("id", "type") VALUES (1, 21), (2, 22), (3, 23), (4, 47), (5, 1001)`
    );

    const migration = new RemapDiscoverSliderTypes1787510000000();
    await migration.up(dataSource.createQueryRunner());

    const rows: { id: number; type: number }[] = await dataSource.query(
      `SELECT "id", "type" FROM "discover_slider" ORDER BY "id"`
    );
    assert.deepEqual(rows, [
      { id: 1, type: 21 },
      { id: 2, type: 1001 },
      { id: 3, type: 1002 },
      { id: 4, type: 1026 },
      { id: 5, type: 1001 },
    ]);

    await migration.up(dataSource.createQueryRunner());
    const secondPass: { id: number; type: number }[] = await dataSource.query(
      `SELECT "id", "type" FROM "discover_slider" ORDER BY "id"`
    );
    assert.deepEqual(secondPass, rows);
  });
});
