import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateJobExecutionState1786200000000 implements MigrationInterface {
  name = 'CreateJobExecutionState1786200000000';
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "job_execution_state" ("jobId" character varying(128) NOT NULL, "lastStartedAt" TIMESTAMP, "lastSucceededAt" TIMESTAMP, "lastFailedAt" TIMESTAMP, "lastFailureSummary" character varying(512), "consecutiveFailures" integer NOT NULL DEFAULT 0, CONSTRAINT "PK_job_execution_state" PRIMARY KEY ("jobId"))`
    );
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "job_execution_state"`);
  }
}
