import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTraktUserIdUserSetting1784500000000 implements MigrationInterface {
  name = 'AddTraktUserIdUserSetting1784500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "traktUserId" character varying`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_user_settings_traktUserId" ON "user_settings" ("traktUserId") WHERE "traktUserId" IS NOT NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_user_settings_traktUserId"`);
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "traktUserId"`
    );
  }
}
