import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReleaseSyncFence1785910000000 implements MigrationInterface {
  name = 'AddReleaseSyncFence1785910000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "release_sync_state" ADD "leaseFence" integer NOT NULL DEFAULT 0`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "release_sync_state" DROP COLUMN "leaseFence"`
    );
  }
}
