import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateDesktopAuthTickets1785700000000 implements MigrationInterface {
  name = 'CreateDesktopAuthTickets1785700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "desktop_auth_ticket" ("id" SERIAL NOT NULL, "userId" integer NOT NULL, "ticketDigest" character varying(64) NOT NULL, "challengeDigest" character varying(64) NOT NULL, "protocolVersion" integer NOT NULL, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "consumedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_desktop_auth_ticket_digest" UNIQUE ("ticketDigest"), CONSTRAINT "PK_desktop_auth_ticket" PRIMARY KEY ("id"))`
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
