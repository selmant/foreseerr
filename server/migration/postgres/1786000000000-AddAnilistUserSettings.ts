import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAnilistUserSettings1786000000000 implements MigrationInterface {
  name = 'AddAnilistUserSettings1786000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "anilistAccessToken" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "anilistTokenExpiresAt" bigint`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "anilistUsername" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "anilistUserId" character varying`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_user_settings_anilistUserId" ON "user_settings" ("anilistUserId") WHERE "anilistUserId" IS NOT NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_user_settings_anilistUserId"`);
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "anilistUserId"`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "anilistUsername"`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "anilistTokenExpiresAt"`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "anilistAccessToken"`
    );
  }
}
