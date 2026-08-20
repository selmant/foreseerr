import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddActiveOngoingEpisodeRequestConstraint1786200000000 implements MigrationInterface {
  name = 'AddActiveOngoingEpisodeRequestConstraint1786200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD "ongoingEpisodeRequestKey" character varying`
    );
    await queryRunner.query(
      `UPDATE "media_request" SET "ongoingEpisodeRequestKey" = CAST("media"."tmdbId" AS TEXT) || ':' || CASE WHEN "media_request"."is4k" THEN '4k' ELSE 'sd' END FROM "media" WHERE "media"."id" = "media_request"."mediaId" AND "media_request"."episodeSelectionType" = 'after'`
    );
    // Historical replicas may already contain duplicate active requests. Keep
    // the oldest request and retire later duplicates so the database invariant
    // is true immediately after the upgrade instead of leaving unindexed rows
    // that could later be reactivated outside the constraint.
    await queryRunner.query(
      `UPDATE "media_request" AS "request" SET "status" = 3 WHERE "episodeSelectionType" = 'after' AND "status" NOT IN (3, 5) AND EXISTS (SELECT 1 FROM "media_request" AS "earlier" WHERE "earlier"."episodeSelectionType" = 'after' AND "earlier"."status" NOT IN (3, 5) AND "earlier"."ongoingEpisodeRequestKey" = "request"."ongoingEpisodeRequestKey" AND "earlier"."id" < "request"."id")`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_media_request_active_ongoing_episode" ON "media_request" ("ongoingEpisodeRequestKey") WHERE "episodeSelectionType" = 'after' AND "status" NOT IN (3, 5)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_media_request_active_ongoing_episode"`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "ongoingEpisodeRequestKey"`
    );
  }
}
