import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAutoCompleteSkippedEpisodeEndings1787000000000 implements MigrationInterface {
  name = 'AddAutoCompleteSkippedEpisodeEndings1787000000000';
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "autoCompleteSkippedEpisodeEndings" boolean`
    );
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "autoCompleteSkippedEpisodeEndings"`
    );
  }
}
