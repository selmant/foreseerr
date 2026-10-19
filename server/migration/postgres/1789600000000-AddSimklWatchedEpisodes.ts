import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSimklWatchedEpisodes1789600000000 implements MigrationInterface {
  name = 'AddSimklWatchedEpisodes1789600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "simkl_sync_item" ADD "watchedEpisodes" text`
    );
    // Cached libraries have no episodes yet: the next sync pulls them in full.
    await queryRunner.query(
      `UPDATE "simkl_sync_state" SET "initialSyncComplete" = false`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "simkl_sync_item" DROP COLUMN "watchedEpisodes"`
    );
  }
}
