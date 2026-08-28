import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMappingGapSuggestion1787420000000 implements MigrationInterface {
  name = 'AddMappingGapSuggestion1787420000000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mapping_gap" ADD COLUMN "suggestedTarget" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "mapping_gap" ADD COLUMN "suggestedConfidence" integer`
    );
    await queryRunner.query(
      `ALTER TABLE "mapping_gap" ADD COLUMN "suggestedBy" character varying`
    );
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mapping_gap" DROP COLUMN "suggestedBy"`
    );
    await queryRunner.query(
      `ALTER TABLE "mapping_gap" DROP COLUMN "suggestedConfidence"`
    );
    await queryRunner.query(
      `ALTER TABLE "mapping_gap" DROP COLUMN "suggestedTarget"`
    );
  }
}
