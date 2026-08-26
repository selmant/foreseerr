import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddServarrInterventions1787200000000 implements MigrationInterface {
  name = 'AddServarrInterventions1787200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "servarr_intervention" ("id" SERIAL NOT NULL, "serviceType" character varying NOT NULL, "serviceId" integer NOT NULL, "serviceName" character varying NOT NULL, "is4k" boolean NOT NULL DEFAULT false, "queueId" integer NOT NULL, "downloadId" character varying, "outputPath" character varying, "externalServiceId" integer NOT NULL, "mediaId" integer NOT NULL, "tmdbId" integer NOT NULL, "mediaType" character varying NOT NULL, "releaseTitle" character varying NOT NULL, "warningMessages" text NOT NULL, "manualImportCapable" boolean NOT NULL DEFAULT false, "state" character varying NOT NULL DEFAULT 'active', "resolution" character varying, "actedByUserId" integer, "cleanupError" text, "firstSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "cleanupDeadlineAt" TIMESTAMP WITH TIME ZONE NOT NULL, "resolvedAt" TIMESTAMP WITH TIME ZONE, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_servarr_intervention" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_servarr_intervention_queue" ON "servarr_intervention" ("serviceType", "serviceId", "queueId")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_servarr_intervention_state_seen" ON "servarr_intervention" ("state", "firstSeenAt")`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "servarrInterventionsSeenAt" TIMESTAMP WITH TIME ZONE`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "servarrInterventionsSeenAt"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_servarr_intervention_state_seen"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_servarr_intervention_queue"`
    );
    await queryRunner.query(`DROP TABLE "servarr_intervention"`);
  }
}
