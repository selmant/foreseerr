import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDiscoverSliderSort1784400000000 implements MigrationInterface {
  name = 'AddDiscoverSliderSort1784400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "discover_slider" ADD "sort" character varying`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "discover_slider" DROP COLUMN "sort"`);
  }
}
