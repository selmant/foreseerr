import type { MigrationInterface, QueryRunner } from 'typeorm';

export class BackfillWatchAheadMonitoredAt1789700000000 implements MigrationInterface {
  name = 'BackfillWatchAheadMonitoredAt1789700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Before monitoredAt existed, watch-ahead children were monitored when
    // they were added. Without this, the first sync monitors old children
    // again, including episodes a cleanup tool had already deleted.
    await queryRunner.query(
      `UPDATE "episode_request" SET "monitoredAt" = "createdAt" WHERE "monitoredAt" IS NULL AND "requestId" IN (SELECT "id" FROM "media_request" WHERE "episodeSelectionType" = 'watchAhead')`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // A backfilled row is the only kind whose monitoredAt equals createdAt
    // exactly: the sync writes monitoredAt later, with its own clock.
    await queryRunner.query(
      `UPDATE "episode_request" SET "monitoredAt" = NULL WHERE "monitoredAt" = "createdAt" AND "requestId" IN (SELECT "id" FROM "media_request" WHERE "episodeSelectionType" = 'watchAhead')`
    );
  }
}
