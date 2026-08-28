import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMappingGap1787400000000 implements MigrationInterface {
  name = 'CreateMappingGap1787400000000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "mapping_gap" ("id" SERIAL NOT NULL, "namespace" character varying NOT NULL, "externalId" character varying NOT NULL, "season" integer NOT NULL DEFAULT -1, "title" character varying, "year" integer, "mediaType" character varying, "discoverSource" character varying, "reason" character varying NOT NULL DEFAULT 'unresolved', "status" character varying NOT NULL DEFAULT 'open', "rejectedTarget" character varying, "sourceKey" character varying, "hitCount" integer NOT NULL DEFAULT 1, "firstSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL, "lastSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_mapping_gap" PRIMARY KEY ("id"))`
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
