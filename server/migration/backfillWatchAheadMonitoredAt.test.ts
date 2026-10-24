import dataSource from '@server/datasource';
import { BackfillWatchAheadMonitoredAt1789700000000 } from '@server/migration/sqlite/1789700000000-BackfillWatchAheadMonitoredAt';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

setupTestDb();

describe('BackfillWatchAheadMonitoredAt', () => {
  it('dates watch-ahead children from when they were added and keeps real dates', async () => {
    // Raw rows: saving entities would run the request subscriber.
    await dataSource.query(
      `INSERT INTO "media_request" ("id", "status", "type", "episodeSelectionType") VALUES (9001, 2, 'tv', 'watchAhead'), (9002, 2, 'tv', 'after')`
    );
    await dataSource.query(
      `INSERT INTO "episode_request" ("requestId", "tvdbId", "seasonNumber", "episodeNumber", "createdAt", "monitoredAt") VALUES
        (9001, 11, 1, 1, '2026-09-01 10:00:00', NULL),
        (9001, 12, 1, 2, '2026-09-01 10:00:00', '2026-10-20 10:00:00'),
        (9002, 21, 1, 1, '2026-09-01 10:00:00', NULL)`
    );

    const migration = new BackfillWatchAheadMonitoredAt1789700000000();
    await dataSource.transaction((manager) =>
      migration.up(manager.queryRunner as never)
    );

    const dates = async () => {
      const rows: { tvdbId: number; monitoredAt: string | null }[] =
        await dataSource.query(
          `SELECT "tvdbId", "monitoredAt" FROM "episode_request" WHERE "requestId" IN (9001, 9002) ORDER BY "tvdbId"`
        );
      return rows.map((row) => [row.tvdbId, row.monitoredAt]);
    };
    assert.deepEqual(await dates(), [
      [11, '2026-09-01 10:00:00'],
      [12, '2026-10-20 10:00:00'],
      [21, null],
    ]);

    await dataSource.transaction((manager) =>
      migration.down(manager.queryRunner as never)
    );
    assert.deepEqual(
      await dates(),
      [
        [11, null],
        [12, '2026-10-20 10:00:00'],
        [21, null],
      ],
      'down clears only backfilled dates'
    );
  });
});
