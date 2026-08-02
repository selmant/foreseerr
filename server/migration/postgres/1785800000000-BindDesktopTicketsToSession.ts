import type { MigrationInterface, QueryRunner } from 'typeorm';

export class BindDesktopTicketsToSession1785800000000 implements MigrationInterface {
  name = 'BindDesktopTicketsToSession1785800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "desktop_auth_ticket"`);
    await queryRunner.query(
      `ALTER TABLE "desktop_auth_ticket" ADD "sessionId" character varying(255) NOT NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "desktop_auth_ticket" DROP COLUMN "sessionId"`
    );
  }
}
