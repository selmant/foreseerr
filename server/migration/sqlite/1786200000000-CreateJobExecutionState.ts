import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateJobExecutionState1786200000000 implements MigrationInterface {
  name = 'CreateJobExecutionState1786200000000';
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "job_execution_state" ("jobId" varchar(128) PRIMARY KEY NOT NULL, "lastStartedAt" datetime, "lastSucceededAt" datetime, "lastFailedAt" datetime, "lastFailureSummary" varchar(512), "consecutiveFailures" integer NOT NULL DEFAULT (0))`
    );
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "job_execution_state"`);
  }
}
