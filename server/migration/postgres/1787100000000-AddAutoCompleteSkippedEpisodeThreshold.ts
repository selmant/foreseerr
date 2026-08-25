import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAutoCompleteSkippedEpisodeThreshold1787100000000 implements MigrationInterface {
  name = 'AddAutoCompleteSkippedEpisodeThreshold1787100000000';
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "autoCompleteSkippedEpisodeThreshold" integer`
    );
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "autoCompleteSkippedEpisodeThreshold"`
    );
  }
}
