import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReleaseSyncState1785900000000 implements MigrationInterface {
  name = 'AddReleaseSyncState1785900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "release_sync_state" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "source" varchar NOT NULL, "sourceServerId" integer NOT NULL, "lastSuccessfulIncrementalAt" datetime, "lastSuccessfulBackfillAt" datetime, "lastErrorAt" datetime, "lastError" text, "leaseOwner" varchar, "leaseExpiresAt" datetime, CONSTRAINT "UQ_release_sync_state_source_server" UNIQUE ("source", "sourceServerId"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_release_sync_state_lease_expires_at" ON "release_sync_state" ("leaseExpiresAt")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_release_sync_state_lease_expires_at"`
    );
    await queryRunner.query(`DROP TABLE "release_sync_state"`);
  }
}
