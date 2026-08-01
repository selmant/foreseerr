import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReleaseCalendar1785300000000 implements MigrationInterface {
  name = 'AddReleaseCalendar1785300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "release_occurrence" ("id" SERIAL NOT NULL, "source" character varying NOT NULL, "sourceServerId" integer NOT NULL, "sourceItemId" integer NOT NULL, "sourceSeriesId" integer, "mediaType" character varying NOT NULL, "tmdbId" integer, "tvdbId" integer, "mediaId" integer, "title" character varying NOT NULL, "subtitle" character varying, "seasonNumber" integer, "episodeNumber" integer, "dateType" character varying NOT NULL, "startsAt" TIMESTAMP WITH TIME ZONE NOT NULL, "allDay" boolean NOT NULL DEFAULT false, "monitored" boolean NOT NULL DEFAULT true, "hasFile" boolean NOT NULL DEFAULT false, "is4k" boolean NOT NULL DEFAULT false, "sourceUrl" character varying, "rawDates" text, "firstSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL, "lastSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL, "missingSince" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_release_occurrence_source_item_date_type" UNIQUE ("source", "sourceServerId", "sourceItemId", "dateType"), CONSTRAINT "PK_release_occurrence" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `ALTER TABLE "release_occurrence" ADD CONSTRAINT "FK_release_occurrence_media" FOREIGN KEY ("mediaId") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_release_occurrence_media" ON "release_occurrence" ("mediaId")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_release_occurrence_starts_at_media_type" ON "release_occurrence" ("startsAt", "mediaType")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_release_occurrence_missing_since" ON "release_occurrence" ("missingSince")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_release_occurrence_series_detection" ON "release_occurrence" ("sourceServerId", "sourceSeriesId", "seasonNumber", "episodeNumber")`
    );
    await queryRunner.query(
      `CREATE TABLE "release_date_change" ("id" SERIAL NOT NULL, "occurrenceId" integer NOT NULL, "oldStartsAt" TIMESTAMP WITH TIME ZONE, "newStartsAt" TIMESTAMP WITH TIME ZONE, "changeKind" character varying NOT NULL, "detectedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "notifiable" boolean NOT NULL DEFAULT false, "metadata" text, CONSTRAINT "PK_release_date_change" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `ALTER TABLE "release_date_change" ADD CONSTRAINT "FK_release_date_change_occurrence" FOREIGN KEY ("occurrenceId") REFERENCES "release_occurrence"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_release_date_change_occurrence" ON "release_date_change" ("occurrenceId")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_release_date_change_occurrence"`
    );
    await queryRunner.query(
      `ALTER TABLE "release_date_change" DROP CONSTRAINT "FK_release_date_change_occurrence"`
    );
    await queryRunner.query(`DROP TABLE "release_date_change"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_release_occurrence_series_detection"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_release_occurrence_missing_since"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_release_occurrence_starts_at_media_type"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_release_occurrence_media"`
    );
    await queryRunner.query(
      `ALTER TABLE "release_occurrence" DROP CONSTRAINT "FK_release_occurrence_media"`
    );
    await queryRunner.query(`DROP TABLE "release_occurrence"`);
  }
}
