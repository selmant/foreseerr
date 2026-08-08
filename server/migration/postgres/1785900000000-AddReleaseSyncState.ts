import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReleaseSyncState1785900000000 implements MigrationInterface {
  name = 'AddReleaseSyncState1785900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "release_sync_state" ("id" SERIAL NOT NULL, "source" character varying NOT NULL, "sourceServerId" integer NOT NULL, "lastSuccessfulIncrementalAt" TIMESTAMP WITH TIME ZONE, "lastSuccessfulBackfillAt" TIMESTAMP WITH TIME ZONE, "lastErrorAt" TIMESTAMP WITH TIME ZONE, "lastError" text, "leaseOwner" character varying, "leaseExpiresAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_release_sync_state_source_server" UNIQUE ("source", "sourceServerId"), CONSTRAINT "PK_release_sync_state" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_release_sync_state_lease_expires_at" ON "release_sync_state" ("leaseExpiresAt")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_release_sync_state_lease_expires_at"`
    );
    await queryRunner.query(`DROP TABLE "release_sync_state"`);
  }
}
