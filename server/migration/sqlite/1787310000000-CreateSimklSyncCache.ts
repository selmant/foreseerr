import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSimklSyncCache1787310000000 implements MigrationInterface {
  name = 'CreateSimklSyncCache1787310000000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "simkl_sync_state" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "activities" text, "initialSyncComplete" boolean NOT NULL DEFAULT (0), "lastCheckedAt" datetime, "lastSuccessfulSyncAt" datetime, "lastError" text, "userId" integer, CONSTRAINT "REL_simkl_sync_state_user" UNIQUE ("userId"), CONSTRAINT "FK_simkl_sync_state_user" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE)`
    );
    await queryRunner.query(
      `CREATE TABLE "simkl_sync_item" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "simklId" varchar NOT NULL, "simklType" varchar NOT NULL, "tmdbId" integer, "tvdbId" integer, "slug" varchar, "title" varchar NOT NULL, "year" integer, "posterPath" varchar, "animeType" varchar, "status" varchar NOT NULL, "userRating" float, "addedAt" datetime, "lastWatchedAt" datetime, "watchedEpisodeCount" integer, "totalEpisodeCount" integer, "userId" integer, CONSTRAINT "FK_simkl_sync_item_user" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE)`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_simkl_item_identity" ON "simkl_sync_item" ("userId", "simklType", "simklId")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_simkl_item_status" ON "simkl_sync_item" ("userId", "status")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_simkl_item_tmdb" ON "simkl_sync_item" ("userId", "tmdbId")`
    );
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "simkl_sync_item"`);
    await queryRunner.query(`DROP TABLE "simkl_sync_state"`);
  }
}
