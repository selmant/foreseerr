import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReleaseCalendar1785300000000 implements MigrationInterface {
  name = 'AddReleaseCalendar1785300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "release_occurrence" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "source" varchar NOT NULL, "sourceServerId" integer NOT NULL, "sourceItemId" integer NOT NULL, "sourceSeriesId" integer, "mediaType" varchar NOT NULL, "tmdbId" integer, "tvdbId" integer, "mediaId" integer, "title" varchar NOT NULL, "subtitle" varchar, "seasonNumber" integer, "episodeNumber" integer, "dateType" varchar NOT NULL, "startsAt" datetime NOT NULL, "allDay" boolean NOT NULL DEFAULT (0), "monitored" boolean NOT NULL DEFAULT (1), "hasFile" boolean NOT NULL DEFAULT (0), "is4k" boolean NOT NULL DEFAULT (0), "sourceUrl" varchar, "rawDates" text, "firstSeenAt" datetime NOT NULL, "lastSeenAt" datetime NOT NULL, "missingSince" datetime, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), CONSTRAINT "UQ_release_occurrence_source_item_date_type" UNIQUE ("source", "sourceServerId", "sourceItemId", "dateType"), CONSTRAINT "FK_release_occurrence_media" FOREIGN KEY ("mediaId") REFERENCES "media" ("id") ON DELETE SET NULL ON UPDATE NO ACTION)`
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
      `CREATE TABLE "release_date_change" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "occurrenceId" integer NOT NULL, "oldStartsAt" datetime, "newStartsAt" datetime, "changeKind" varchar NOT NULL, "detectedAt" datetime NOT NULL, "notifiable" boolean NOT NULL DEFAULT (0), "metadata" text, CONSTRAINT "FK_release_date_change_occurrence" FOREIGN KEY ("occurrenceId") REFERENCES "release_occurrence" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_release_date_change_occurrence" ON "release_date_change" ("occurrenceId")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_release_date_change_occurrence"`);
    await queryRunner.query(`DROP TABLE "release_date_change"`);
    await queryRunner.query(
      `DROP INDEX "IDX_release_occurrence_series_detection"`
    );
    await queryRunner.query(
      `DROP INDEX "IDX_release_occurrence_missing_since"`
    );
    await queryRunner.query(
      `DROP INDEX "IDX_release_occurrence_starts_at_media_type"`
    );
    await queryRunner.query(`DROP INDEX "IDX_release_occurrence_media"`);
    await queryRunner.query(`DROP TABLE "release_occurrence"`);
  }
}
