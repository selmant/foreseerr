import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSimklUserSettings1787300000000 implements MigrationInterface {
  name = 'AddSimklUserSettings1787300000000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "simklAccessToken" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "simklUsername" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "simklUserId" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "mediaActionsSimklEnabled" boolean`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_user_settings_simklUserId" ON "user_settings" ("simklUserId") WHERE "simklUserId" IS NOT NULL`
    );
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_user_settings_simklUserId"`);
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "mediaActionsSimklEnabled"`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "simklUserId"`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "simklUsername"`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "simklAccessToken"`
    );
  }
}
