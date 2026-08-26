import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddServarrInterventions1787200000000 implements MigrationInterface {
  name = 'AddServarrInterventions1787200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "servarr_intervention" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "serviceType" varchar NOT NULL, "serviceId" integer NOT NULL, "serviceName" varchar NOT NULL, "is4k" boolean NOT NULL DEFAULT (0), "queueId" integer NOT NULL, "downloadId" varchar, "outputPath" varchar, "externalServiceId" integer NOT NULL, "mediaId" integer NOT NULL, "tmdbId" integer NOT NULL, "mediaType" varchar NOT NULL, "releaseTitle" varchar NOT NULL, "warningMessages" text NOT NULL, "manualImportCapable" boolean NOT NULL DEFAULT (0), "state" varchar NOT NULL DEFAULT ('active'), "resolution" varchar, "actedByUserId" integer, "cleanupError" text, "firstSeenAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "cleanupDeadlineAt" datetime NOT NULL, "resolvedAt" datetime, "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_servarr_intervention_queue" ON "servarr_intervention" ("serviceType", "serviceId", "queueId")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_servarr_intervention_state_seen" ON "servarr_intervention" ("state", "firstSeenAt")`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "servarrInterventionsSeenAt" datetime`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "servarrInterventionsSeenAt"`
    );
    await queryRunner.query(`DROP INDEX "IDX_servarr_intervention_state_seen"`);
    await queryRunner.query(`DROP INDEX "IDX_servarr_intervention_queue"`);
    await queryRunner.query(`DROP TABLE "servarr_intervention"`);
  }
}
