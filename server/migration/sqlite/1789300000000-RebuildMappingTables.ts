import type { MigrationInterface, QueryRunner } from 'typeorm';
import { CreateMappingGap1787400000000 } from './1787400000000-CreateMappingGap';
import { CreateMappingGraph1787410000000 } from './1787410000000-CreateMappingGraph';
import { AddMappingGapSuggestion1787420000000 } from './1787420000000-AddMappingGapSuggestion';
import { IndexMappingSourceKey1787430000000 } from './1787430000000-IndexMappingSourceKey';
import { MappingLinkProvenance1787440000000 } from './1787440000000-MappingLinkProvenance';

/**
 * Replace the identity graph with a lookup into TMDB.
 *
 * Seven tables become three: dataset state, dataset edges as published, and
 * every other answer or miss. Manual overrides that pointed at TMDB carry over
 * as corrections; everything else is rebuilt from the datasets on first use.
 */
export class RebuildMappingTables1789300000000 implements MigrationInterface {
  name = 'RebuildMappingTables1789300000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "mapping_dataset" ("key" varchar NOT NULL, "enabled" boolean NOT NULL DEFAULT (1), "generation" integer NOT NULL DEFAULT (0), "edgeCount" integer, "version" varchar, "etag" varchar, "lastModified" varchar, "lastFetchedAt" datetime, "lastSuccessAt" datetime, "lastError" text, CONSTRAINT "PK_mapping_dataset" PRIMARY KEY ("key"))`
    );

    await queryRunner.query(
      `CREATE TABLE "mapping_edge" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "dataset" varchar NOT NULL, "generation" integer NOT NULL, "srcNs" varchar NOT NULL, "srcId" varchar NOT NULL, "srcScope" varchar NOT NULL DEFAULT (''), "dstNs" varchar NOT NULL, "dstId" varchar NOT NULL, "dstScope" varchar NOT NULL DEFAULT (''), "srcRange" varchar, "dstRange" varchar)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mapping_edge_source" ON "mapping_edge" ("srcNs", "srcId")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mapping_edge_generation" ON "mapping_edge" ("dataset", "generation")`
    );

    await queryRunner.query(
      `CREATE TABLE "mapping_resolution" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "srcNs" varchar NOT NULL, "srcId" varchar NOT NULL, "mediaType" varchar NOT NULL DEFAULT (''), "tmdbId" integer, "tmdbType" varchar, "origin" varchar NOT NULL, "title" varchar, "year" integer, "discoverSource" varchar, "detail" varchar, "hitCount" integer NOT NULL DEFAULT (0), "createdByUserId" integer, "checkedAt" datetime NOT NULL, "createdAt" datetime NOT NULL, "updatedAt" datetime NOT NULL)`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_mapping_resolution_identity" ON "mapping_resolution" ("srcNs", "srcId", "mediaType")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mapping_resolution_list" ON "mapping_resolution" ("origin", "hitCount")`
    );

    // A real target before an empty one, so a "does not exist" override never
    // shadows a correction for the same item.
    await queryRunner.query(
      `INSERT OR IGNORE INTO "mapping_resolution" ("srcNs", "srcId", "mediaType", "tmdbId", "tmdbType", "origin", "detail", "hitCount", "createdByUserId", "checkedAt", "createdAt", "updatedAt") SELECT "fromNamespace", "fromExternalId", '', CASE WHEN "toExternalId" = '' THEN NULL ELSE CAST("toExternalId" AS integer) END, CASE WHEN "toExternalId" = '' THEN NULL WHEN "toNamespace" = 'tmdb_movie' THEN 'movie' ELSE 'tv' END, 'manual', "note", 0, "createdByUserId", "updatedAt", "createdAt", "updatedAt" FROM "mapping_override" WHERE "toNamespace" IN ('tmdb_movie', 'tmdb_show') AND "fromSeason" = -1 AND "fromNamespace" IN ('tmdb_movie', 'tmdb_show', 'tvdb_movie', 'tvdb_show', 'imdb', 'anidb', 'anilist', 'mal', 'simkl', 'trakt') AND ("toExternalId" = '' OR "toExternalId" NOT GLOB '*[^0-9]*') ORDER BY ("toExternalId" = '') ASC, "updatedAt" DESC`
    );

    await queryRunner.query(`DROP TABLE "mapping_source_usage"`);
    await queryRunner.query(`DROP TABLE "mapping_source"`);
    await queryRunner.query(`DROP TABLE "mapping_override"`);
    await queryRunner.query(`DROP TABLE "mapping_episode_rule"`);
    await queryRunner.query(`DROP TABLE "mapping_link"`);
    await queryRunner.query(`DROP TABLE "mapping_cluster"`);
    await queryRunner.query(`DROP TABLE "mapping_gap"`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "mapping_resolution"`);
    await queryRunner.query(`DROP TABLE "mapping_edge"`);
    await queryRunner.query(`DROP TABLE "mapping_dataset"`);

    // The old tables come back empty, in the shape their own migrations left.
    await new CreateMappingGap1787400000000().up(queryRunner);
    await new CreateMappingGraph1787410000000().up(queryRunner);
    await new AddMappingGapSuggestion1787420000000().up(queryRunner);
    await new IndexMappingSourceKey1787430000000().up(queryRunner);
    await new MappingLinkProvenance1787440000000().up(queryRunner);
  }
}
