import type { MigrationInterface, QueryRunner } from 'typeorm';

export class MappingLinkProvenance1787440000000 implements MigrationInterface {
  name = 'MappingLinkProvenance1787440000000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_mapping_link_identity"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_mapping_link_identity" ON "mapping_link" ("namespace", "externalId", "season", "clusterId", "sourceKey")`
    );
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_mapping_link_identity"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_mapping_link_identity" ON "mapping_link" ("namespace", "externalId", "season", "clusterId")`
    );
  }
}
