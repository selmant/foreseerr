import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWatchAheadMonitorTracking1789400000000 implements MigrationInterface {
  name = 'AddWatchAheadMonitorTracking1789400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "episode_request" ADD "monitoredAt" datetime`
    );
    await queryRunner.query(
      `ALTER TABLE "episode_request" ADD "unmonitoredAt" datetime`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD "watchAheadInactiveAt" datetime`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "watchAheadInactiveAt"`
    );
    await queryRunner.query(
      `ALTER TABLE "episode_request" DROP COLUMN "unmonitoredAt"`
    );
    await queryRunner.query(
      `ALTER TABLE "episode_request" DROP COLUMN "monitoredAt"`
    );
  }
}
