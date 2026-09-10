import type { MigrationInterface, QueryRunner } from 'typeorm';

export class RemapDiscoverSliderTypes1787510000000 implements MigrationInterface {
  name = 'RemapDiscoverSliderTypes1787510000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "discover_slider" SET "type" = "type" + 979 WHERE "type" >= 22 AND "type" < 1001`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "discover_slider" SET "type" = "type" - 979 WHERE "type" >= 1001 AND "type" < 1980`
    );
  }
}
