import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMappingGraph1787410000000 implements MigrationInterface {
  name = 'CreateMappingGraph1787410000000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "mapping_cluster" ("id" SERIAL NOT NULL, "kind" character varying NOT NULL, "canonicalTmdbId" integer, "canonicalTmdbType" character varying, "title" character varying, "year" integer, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_mapping_cluster" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mapping_cluster_canonical" ON "mapping_cluster" ("canonicalTmdbType", "canonicalTmdbId")`
    );

    await queryRunner.query(
      `CREATE TABLE "mapping_link" ("id" SERIAL NOT NULL, "clusterId" integer NOT NULL, "namespace" character varying NOT NULL, "externalId" character varying NOT NULL, "season" integer NOT NULL DEFAULT -1, "confidence" integer NOT NULL, "sourceKey" character varying NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_mapping_link" PRIMARY KEY ("id"), CONSTRAINT "FK_mapping_link_cluster" FOREIGN KEY ("clusterId") REFERENCES "mapping_cluster"("id") ON DELETE CASCADE)`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_mapping_link_identity" ON "mapping_link" ("namespace", "externalId", "season", "clusterId")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mapping_link_lookup" ON "mapping_link" ("namespace", "externalId")`
    );

    await queryRunner.query(
      `CREATE TABLE "mapping_episode_rule" ("id" SERIAL NOT NULL, "clusterId" integer NOT NULL, "sourceNamespace" character varying NOT NULL, "sourceExternalId" character varying, "sourceSeason" integer NOT NULL DEFAULT -1, "sourceRange" character varying NOT NULL, "targetNamespace" character varying NOT NULL, "targetExternalId" character varying, "targetSeason" integer NOT NULL DEFAULT -1, "targetRange" character varying NOT NULL, "ratio" integer NOT NULL DEFAULT 1, "confidence" integer NOT NULL, "sourceKey" character varying NOT NULL, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_mapping_episode_rule" PRIMARY KEY ("id"), CONSTRAINT "FK_mapping_episode_rule_cluster" FOREIGN KEY ("clusterId") REFERENCES "mapping_cluster"("id") ON DELETE CASCADE)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mapping_episode_rule_lookup" ON "mapping_episode_rule" ("clusterId", "sourceNamespace", "targetNamespace")`
    );

    await queryRunner.query(
      `CREATE TABLE "mapping_override" ("id" SERIAL NOT NULL, "fromNamespace" character varying NOT NULL, "fromExternalId" character varying NOT NULL, "fromSeason" integer NOT NULL DEFAULT -1, "toNamespace" character varying NOT NULL, "toExternalId" character varying NOT NULL, "toSeason" integer NOT NULL DEFAULT -1, "note" character varying, "createdByUserId" integer, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_mapping_override" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_mapping_override_identity" ON "mapping_override" ("fromNamespace", "fromExternalId", "fromSeason", "toNamespace")`
    );

    await queryRunner.query(
      `CREATE TABLE "mapping_source" ("id" SERIAL NOT NULL, "key" character varying NOT NULL, "kind" character varying NOT NULL, "enabled" boolean NOT NULL DEFAULT true, "priority" integer NOT NULL DEFAULT 100, "trust" integer NOT NULL DEFAULT 50, "namespaceTrust" text, "format" character varying, "mirrors" text, "fieldMap" text, "namespaceMap" text, "licence" character varying, "legalNote" text, "version" character varying, "etag" character varying, "lastModified" character varying, "lastFetchedAt" TIMESTAMP WITH TIME ZONE, "lastSuccessAt" TIMESTAMP WITH TIME ZONE, "lastError" text, "entryCount" integer, "costClass" character varying NOT NULL DEFAULT 'both', "rps" double precision NOT NULL DEFAULT 2, "burst" integer NOT NULL DEFAULT 4, "concurrency" integer NOT NULL DEFAULT 2, "dailyQuota" integer, "batchSize" integer, "backpressure" character varying NOT NULL DEFAULT 'none', "circuitState" character varying NOT NULL DEFAULT 'closed', "circuitOpenedAt" TIMESTAMP WITH TIME ZONE, "consecutiveFailures" integer NOT NULL DEFAULT 0, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_mapping_source" PRIMARY KEY ("id"), CONSTRAINT "UQ_mapping_source_key" UNIQUE ("key"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mapping_source_kind" ON "mapping_source" ("kind", "enabled")`
    );

    await queryRunner.query(
      `CREATE TABLE "mapping_source_usage" ("id" SERIAL NOT NULL, "sourceKey" character varying NOT NULL, "day" character varying NOT NULL, "requests" integer NOT NULL DEFAULT 0, "failures" integer NOT NULL DEFAULT 0, "itemsResolved" integer NOT NULL DEFAULT 0, CONSTRAINT "PK_mapping_source_usage" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_mapping_source_usage_day" ON "mapping_source_usage" ("sourceKey", "day")`
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "mapping_source_usage"`);
    await queryRunner.query(`DROP TABLE "mapping_source"`);
    await queryRunner.query(`DROP TABLE "mapping_override"`);
    await queryRunner.query(`DROP TABLE "mapping_episode_rule"`);
    await queryRunner.query(`DROP TABLE "mapping_link"`);
    await queryRunner.query(`DROP TABLE "mapping_cluster"`);
  }
}
