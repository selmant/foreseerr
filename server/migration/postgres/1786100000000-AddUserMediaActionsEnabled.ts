import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUserMediaActionsEnabled1786100000000 implements MigrationInterface {
  name = 'AddUserMediaActionsEnabled1786100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "mediaActionsTraktEnabled" boolean`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "mediaActionsAnilistEnabled" boolean`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "mediaActionsAnilistEnabled"`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "mediaActionsTraktEnabled"`
    );
  }
}
