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
      WHERE "hideTraktWatched" = 1
    `);

    // SQLite cannot DROP COLUMN on older versions reliably via TypeORM helper;
    // recreate table without hideTraktWatched when needed. Prefer simple DROP
    // which modern SQLite (3.35+) supports.
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "hideTraktWatched"`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "hideTraktWatched" boolean NOT NULL DEFAULT (0)`
    );

    await queryRunner.query(`
      UPDATE "user_settings"
      SET "hideTraktWatched" = 1
      WHERE "discoverFilterDefaults" LIKE '%"ignoreWatched":true%'
    `);

    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "discoverFilterDefaults"`
    );
  }
}
