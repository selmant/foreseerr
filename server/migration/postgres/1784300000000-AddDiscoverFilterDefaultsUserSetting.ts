import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDiscoverFilterDefaultsUserSetting1784300000000 implements MigrationInterface {
  name = 'AddDiscoverFilterDefaultsUserSetting1784300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "discoverFilterDefaults" text`
    );

    await queryRunner.query(`
      UPDATE "user_settings"
      SET "discoverFilterDefaults" = '{"ignoreWatched":true}'
      WHERE "hideTraktWatched" = true
    `);

    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "hideTraktWatched"`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "hideTraktWatched" boolean NOT NULL DEFAULT false`
    );

    await queryRunner.query(`
      UPDATE "user_settings"
      SET "hideTraktWatched" = true
      WHERE "discoverFilterDefaults" LIKE '%"ignoreWatched":true%'
    `);

    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "discoverFilterDefaults"`
    );
  }
}
