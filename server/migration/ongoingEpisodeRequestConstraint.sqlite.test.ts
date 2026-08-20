import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { DataSource } from 'typeorm';

import { AddActiveOngoingEpisodeRequestConstraint1786200000000 } from './sqlite/1786200000000-AddActiveOngoingEpisodeRequestConstraint';

const dataSource = new DataSource({
  type: 'sqlite',
  database: ':memory:',
});

after(async () => {
  if (dataSource.isInitialized) {
    await dataSource.destroy();
  }
});

describe('AddActiveOngoingEpisodeRequestConstraint (SQLite)', () => {
  it('preserves legacy duplicates while creating the partial unique index', async () => {
    await dataSource.initialize();
    await dataSource.query(
      `CREATE TABLE "media" ("id" integer PRIMARY KEY, "tmdbId" integer NOT NULL)`
    );
    await dataSource.query(
      `CREATE TABLE "media_request" ("id" integer PRIMARY KEY, "mediaId" integer, "is4k" boolean NOT NULL DEFAULT (0), "status" integer NOT NULL, "episodeSelectionType" varchar)`
    );
    await dataSource.query(
      `INSERT INTO "media" ("id", "tmdbId") VALUES (1, 42)`
    );
    await dataSource.query(
      `INSERT INTO "media_request" ("id", "mediaId", "is4k", "status", "episodeSelectionType") VALUES (1, 1, 0, 1, 'after'), (2, 1, 0, 2, 'after')`
    );

    const migration =
      new AddActiveOngoingEpisodeRequestConstraint1786200000000();
    await migration.up(dataSource.createQueryRunner());

    const rows: {
      id: number;
      status: number;
      ongoingEpisodeRequestKey: string | null;
    }[] = await dataSource.query(
      `SELECT "id", "status", "ongoingEpisodeRequestKey" FROM "media_request" ORDER BY "id"`
    );
    assert.deepEqual(rows, [
      { id: 1, status: 1, ongoingEpisodeRequestKey: '42:sd' },
      { id: 2, status: 3, ongoingEpisodeRequestKey: '42:sd' },
    ]);

    await assert.rejects(
      dataSource.query(
        `INSERT INTO "media_request" ("id", "mediaId", "is4k", "status", "episodeSelectionType", "ongoingEpisodeRequestKey") VALUES (3, 1, 0, 1, 'after', '42:sd')`
      )
    );
    await assert.rejects(
      dataSource.query(`UPDATE "media_request" SET "status" = 2 WHERE "id" = 2`)
    );
  });
});
