import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMappingGraph1787410000000 implements MigrationInterface {
  name = 'CreateMappingGraph1787410000000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "mapping_cluster" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "kind" varchar NOT NULL, "canonicalTmdbId" integer, "canonicalTmdbType" varchar, "title" varchar, "year" integer, "createdAt" datetime NOT NULL, "updatedAt" datetime NOT NULL)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mapping_cluster_canonical" ON "mapping_cluster" ("canonicalTmdbType", "canonicalTmdbId")`
    );

    await queryRunner.query(
      `CREATE TABLE "mapping_link" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "clusterId" integer NOT NULL, "namespace" varchar NOT NULL, "externalId" varchar NOT NULL, "season" integer NOT NULL DEFAULT (-1), "confidence" integer NOT NULL, "sourceKey" varchar NOT NULL, "createdAt" datetime NOT NULL, "updatedAt" datetime NOT NULL, CONSTRAINT "FK_mapping_link_cluster" FOREIGN KEY ("clusterId") REFERENCES "mapping_cluster" ("id") ON DELETE CASCADE)`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_mapping_link_identity" ON "mapping_link" ("namespace", "externalId", "season", "clusterId")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mapping_link_lookup" ON "mapping_link" ("namespace", "externalId")`
    );

    await queryRunner.query(
      `CREATE TABLE "mapping_episode_rule" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "clusterId" integer NOT NULL, "sourceNamespace" varchar NOT NULL, "sourceExternalId" varchar, "sourceSeason" integer NOT NULL DEFAULT (-1), "sourceRange" varchar NOT NULL, "targetNamespace" varchar NOT NULL, "targetExternalId" varchar, "targetSeason" integer NOT NULL DEFAULT (-1), "targetRange" varchar NOT NULL, "ratio" integer NOT NULL DEFAULT (1), "confidence" integer NOT NULL, "sourceKey" varchar NOT NULL, "updatedAt" datetime NOT NULL, CONSTRAINT "FK_mapping_episode_rule_cluster" FOREIGN KEY ("clusterId") REFERENCES "mapping_cluster" ("id") ON DELETE CASCADE)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mapping_episode_rule_lookup" ON "mapping_episode_rule" ("clusterId", "sourceNamespace", "targetNamespace")`
    );

    await queryRunner.query(
      `CREATE TABLE "mapping_override" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "fromNamespace" varchar NOT NULL, "fromExternalId" varchar NOT NULL, "fromSeason" integer NOT NULL DEFAULT (-1), "toNamespace" varchar NOT NULL, "toExternalId" varchar NOT NULL, "toSeason" integer NOT NULL DEFAULT (-1), "note" varchar, "createdByUserId" integer, "createdAt" datetime NOT NULL, "updatedAt" datetime NOT NULL)`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_mapping_override_identity" ON "mapping_override" ("fromNamespace", "fromExternalId", "fromSeason", "toNamespace")`
    );

    await queryRunner.query(
      `CREATE TABLE "mapping_source" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "key" varchar NOT NULL, "kind" varchar NOT NULL, "enabled" boolean NOT NULL DEFAULT (1), "priority" integer NOT NULL DEFAULT (100), "trust" integer NOT NULL DEFAULT (50), "namespaceTrust" text, "format" varchar, "mirrors" text, "fieldMap" text, "namespaceMap" text, "licence" varchar, "legalNote" text, "version" varchar, "etag" varchar, "lastModified" varchar, "lastFetchedAt" datetime, "lastSuccessAt" datetime, "lastError" text, "entryCount" integer, "costClass" varchar NOT NULL DEFAULT ('both'), "rps" float NOT NULL DEFAULT (2), "burst" integer NOT NULL DEFAULT (4), "concurrency" integer NOT NULL DEFAULT (2), "dailyQuota" integer, "batchSize" integer, "backpressure" varchar NOT NULL DEFAULT ('none'), "circuitState" varchar NOT NULL DEFAULT ('closed'), "circuitOpenedAt" datetime, "consecutiveFailures" integer NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL, "updatedAt" datetime NOT NULL, CONSTRAINT "UQ_mapping_source_key" UNIQUE ("key"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mapping_source_kind" ON "mapping_source" ("kind", "enabled")`
    );

    await queryRunner.query(
      `CREATE TABLE "mapping_source_usage" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "sourceKey" varchar NOT NULL, "day" varchar NOT NULL, "requests" integer NOT NULL DEFAULT (0), "failures" integer NOT NULL DEFAULT (0), "itemsResolved" integer NOT NULL DEFAULT (0))`
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
