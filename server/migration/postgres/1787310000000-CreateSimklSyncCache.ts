import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSimklSyncCache1787310000000 implements MigrationInterface {
  name = 'CreateSimklSyncCache1787310000000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "simkl_sync_state" ("id" SERIAL NOT NULL, "activities" text, "initialSyncComplete" boolean NOT NULL DEFAULT false, "lastCheckedAt" TIMESTAMP, "lastSuccessfulSyncAt" TIMESTAMP, "lastError" text, "userId" integer, CONSTRAINT "REL_simkl_sync_state_user" UNIQUE ("userId"), CONSTRAINT "PK_simkl_sync_state" PRIMARY KEY ("id"), CONSTRAINT "FK_simkl_sync_state_user" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE)`
    );
    await queryRunner.query(
      `CREATE TABLE "simkl_sync_item" ("id" SERIAL NOT NULL, "simklId" character varying NOT NULL, "simklType" character varying NOT NULL, "tmdbId" integer, "tvdbId" integer, "slug" character varying, "title" character varying NOT NULL, "year" integer, "posterPath" character varying, "animeType" character varying, "status" character varying NOT NULL, "userRating" double precision, "addedAt" TIMESTAMP, "lastWatchedAt" TIMESTAMP, "watchedEpisodeCount" integer, "totalEpisodeCount" integer, "userId" integer, CONSTRAINT "PK_simkl_sync_item" PRIMARY KEY ("id"), CONSTRAINT "FK_simkl_sync_item_user" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE)`
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
