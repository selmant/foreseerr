import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTraktUserSettings1784100000000 implements MigrationInterface {
  name = 'AddTraktUserSettings1784100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "traktAccessToken" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "traktRefreshToken" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "traktTokenExpiresAt" bigint`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "traktUsername" character varying`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "traktUsername"`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "traktTokenExpiresAt"`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "traktRefreshToken"`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "traktAccessToken"`
    );
  }
}
