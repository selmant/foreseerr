import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSimklRefreshToken1789500000000 implements MigrationInterface {
  name = 'AddSimklRefreshToken1789500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "simklRefreshToken" varchar`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "simklTokenExpiresAt" bigint`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "simklTokenExpiresAt"`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "simklRefreshToken"`
    );
  }
}
