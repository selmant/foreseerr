import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEpisodeRequests1785250000000 implements MigrationInterface {
  name = 'AddEpisodeRequests1785250000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD "episodeSelectionType" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD "episodeStartTvdbId" integer`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD "episodeEndTvdbId" integer`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD "tvQuotaUnits" integer NOT NULL DEFAULT 0`
    );
    await queryRunner.query(
      `UPDATE "media_request" SET "tvQuotaUnits" = (SELECT COUNT(*)::integer FROM "season_request" WHERE "season_request"."requestId" = "media_request"."id") WHERE "type" = 'tv'`
    );
    await queryRunner.query(
      `CREATE TABLE "episode_request" ("id" SERIAL NOT NULL, "tvdbId" integer NOT NULL, "seasonNumber" integer NOT NULL, "episodeNumber" integer NOT NULL, "title" character varying, "airDate" character varying, "status" integer NOT NULL DEFAULT 1, "searchTriggeredAt" TIMESTAMP WITH TIME ZONE, "requestId" integer, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_episode_request_request_tvdb" UNIQUE ("requestId", "tvdbId"), CONSTRAINT "PK_episode_request" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_episode_request_tvdb" ON "episode_request" ("tvdbId")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_episode_request_request" ON "episode_request" ("requestId")`
    );
    await queryRunner.query(
      `ALTER TABLE "episode_request" ADD CONSTRAINT "FK_episode_request_request" FOREIGN KEY ("requestId") REFERENCES "media_request"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "episode_request" DROP CONSTRAINT "FK_episode_request_request"`
    );
    await queryRunner.query(`DROP INDEX "IDX_episode_request_request"`);
    await queryRunner.query(`DROP INDEX "IDX_episode_request_tvdb"`);
    await queryRunner.query(`DROP TABLE "episode_request"`);
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "tvQuotaUnits"`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "episodeEndTvdbId"`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "episodeStartTvdbId"`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "episodeSelectionType"`
    );
  }
}
