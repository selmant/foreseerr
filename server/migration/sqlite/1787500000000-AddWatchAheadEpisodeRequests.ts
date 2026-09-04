import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWatchAheadEpisodeRequests1787500000000 implements MigrationInterface {
  name = 'AddWatchAheadEpisodeRequests1787500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD "watchAheadCount" integer`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "watchAheadEpisodeCount" integer`
    );
    await queryRunner.query(
      `DROP INDEX "IDX_media_request_active_ongoing_episode"`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_media_request_active_ongoing_episode" ON "media_request" ("ongoingEpisodeRequestKey") WHERE "episodeSelectionType" IN ('after', 'watchAhead') AND "status" NOT IN (3, 5)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_media_request_active_ongoing_episode"`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_media_request_active_ongoing_episode" ON "media_request" ("ongoingEpisodeRequestKey") WHERE "episodeSelectionType" = 'after' AND "status" NOT IN (3, 5)`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "watchAheadEpisodeCount"`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "watchAheadCount"`
    );
  }
}
