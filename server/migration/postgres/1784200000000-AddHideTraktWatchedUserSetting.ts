import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddHideTraktWatchedUserSetting1784200000000 implements MigrationInterface {
  name = 'AddHideTraktWatchedUserSetting1784200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "hideTraktWatched" boolean NOT NULL DEFAULT false`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "hideTraktWatched"`
    );
  }
}
