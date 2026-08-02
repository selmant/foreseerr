import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateDesktopAuthTickets1785700000000 implements MigrationInterface {
  name = 'CreateDesktopAuthTickets1785700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "desktop_auth_ticket" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "userId" integer NOT NULL, "ticketDigest" varchar(64) NOT NULL, "challengeDigest" varchar(64) NOT NULL, "protocolVersion" integer NOT NULL, "expiresAt" datetime NOT NULL, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "consumedAt" datetime, CONSTRAINT "UQ_desktop_auth_ticket_digest" UNIQUE ("ticketDigest"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_desktop_auth_ticket_user" ON "desktop_auth_ticket" ("userId")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_desktop_auth_ticket_expires" ON "desktop_auth_ticket" ("expiresAt")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_desktop_auth_ticket_expires"`);
    await queryRunner.query(`DROP INDEX "IDX_desktop_auth_ticket_user"`);
    await queryRunner.query(`DROP TABLE "desktop_auth_ticket"`);
  }
}
