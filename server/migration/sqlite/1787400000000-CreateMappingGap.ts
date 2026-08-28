import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMappingGap1787400000000 implements MigrationInterface {
  name = 'CreateMappingGap1787400000000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "mapping_gap" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "namespace" varchar NOT NULL, "externalId" varchar NOT NULL, "season" integer NOT NULL DEFAULT (-1), "title" varchar, "year" integer, "mediaType" varchar, "discoverSource" varchar, "reason" varchar NOT NULL DEFAULT ('unresolved'), "status" varchar NOT NULL DEFAULT ('open'), "rejectedTarget" varchar, "sourceKey" varchar, "hitCount" integer NOT NULL DEFAULT (1), "firstSeenAt" datetime NOT NULL, "lastSeenAt" datetime NOT NULL)`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_mapping_gap_identity" ON "mapping_gap" ("namespace", "externalId", "season")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mapping_gap_queue" ON "mapping_gap" ("status", "hitCount")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mapping_gap_source" ON "mapping_gap" ("discoverSource")`
    );
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "mapping_gap"`);
  }
}
