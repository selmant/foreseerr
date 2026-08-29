import type { MigrationInterface, QueryRunner } from 'typeorm';

export class IndexMappingSourceKey1787430000000 implements MigrationInterface {
  name = 'IndexMappingSourceKey1787430000000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_mapping_link_sourceKey" ON "mapping_link" ("sourceKey")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mapping_episode_rule_sourceKey" ON "mapping_episode_rule" ("sourceKey")`
    );
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_mapping_episode_rule_sourceKey"`);
    await queryRunner.query(`DROP INDEX "IDX_mapping_link_sourceKey"`);
  }
}
