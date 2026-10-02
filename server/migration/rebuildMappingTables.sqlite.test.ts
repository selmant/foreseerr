import { bunSqlite3 } from '@server/lib/bunSqlite3';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { DataSource } from 'typeorm';

import { CreateMappingGap1787400000000 } from './sqlite/1787400000000-CreateMappingGap';
import { CreateMappingGraph1787410000000 } from './sqlite/1787410000000-CreateMappingGraph';
import { AddMappingGapSuggestion1787420000000 } from './sqlite/1787420000000-AddMappingGapSuggestion';
import { IndexMappingSourceKey1787430000000 } from './sqlite/1787430000000-IndexMappingSourceKey';
import { MappingLinkProvenance1787440000000 } from './sqlite/1787440000000-MappingLinkProvenance';
import { RebuildMappingTables1789300000000 } from './sqlite/1789300000000-RebuildMappingTables';

const dataSource = new DataSource({
  type: 'sqlite',
  driver: bunSqlite3,
  database: ':memory:',
});

after(async () => {
  if (dataSource.isInitialized) {
    await dataSource.destroy();
  }
});

const tables = async (): Promise<string[]> =>
  (
    await dataSource.query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mapping_%' ORDER BY name`
    )
  ).map((row: { name: string }) => row.name);

describe('RebuildMappingTables (SQLite)', () => {
  it('carries TMDB overrides over as corrections and drops the old tables', async () => {
    await dataSource.initialize();
    const runner = dataSource.createQueryRunner();
    for (const migration of [
      new CreateMappingGap1787400000000(),
      new CreateMappingGraph1787410000000(),
      new AddMappingGapSuggestion1787420000000(),
      new IndexMappingSourceKey1787430000000(),
      new MappingLinkProvenance1787440000000(),
    ]) {
      await migration.up(runner);
    }

    const override = (
      from: string,
      id: string,
      season: number,
      to: string,
      target: string,
      note: string | null
    ) =>
      dataSource.query(
        `INSERT INTO "mapping_override" ("fromNamespace", "fromExternalId", "fromSeason", "toNamespace", "toExternalId", "toSeason", "note", "createdByUserId", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, -1, ?, 1, '2026-09-01 10:00:00', '2026-09-02 10:00:00')`,
        [from, id, season, to, target, note]
      );
    await override('anilist', '21', -1, 'tmdb_show', '37854', 'One Piece');
    await override('trakt', 'some-film', -1, 'tmdb_movie', '603', null);
    // "Has no TMDB counterpart".
    await override('simkl', '99', -1, 'tmdb_show', '', null);
    // A denial and a real target for the same item: the target wins.
    await override('anilist', '5', -1, 'tmdb_show', '', null);
    await override('anilist', '5', -1, 'tmdb_movie', '11299', null);
    // Not carried: aimed at TVDB, season-scoped, a retired namespace, junk id.
    await override('anilist', '1', -1, 'tvdb_show', '76885', null);
    await override('tvdb_show', '70973', 2, 'tmdb_show', '62913', null);
    await override('kitsu', '7', -1, 'tmdb_show', '1', null);
    await override('anilist', '8', -1, 'tmdb_show', 'tt123', null);

    await new RebuildMappingTables1789300000000().up(runner);

    assert.deepEqual(await tables(), [
      'mapping_dataset',
      'mapping_edge',
      'mapping_resolution',
    ]);
    const rows = await dataSource.query(
      `SELECT "srcNs", "srcId", "mediaType", "tmdbId", "tmdbType", "origin", "detail", "createdByUserId" FROM "mapping_resolution" ORDER BY "srcNs", "srcId"`
    );
    assert.deepEqual(rows, [
      {
        srcNs: 'anilist',
        srcId: '21',
        mediaType: '',
        tmdbId: 37854,
        tmdbType: 'tv',
        origin: 'manual',
        detail: 'One Piece',
        createdByUserId: 1,
      },
      {
        srcNs: 'anilist',
        srcId: '5',
        mediaType: '',
        tmdbId: 11299,
        tmdbType: 'movie',
        origin: 'manual',
        detail: null,
        createdByUserId: 1,
      },
      {
        srcNs: 'simkl',
        srcId: '99',
        mediaType: '',
        tmdbId: null,
        tmdbType: null,
        origin: 'manual',
        detail: null,
        createdByUserId: 1,
      },
      {
        srcNs: 'trakt',
        srcId: 'some-film',
        mediaType: '',
        tmdbId: 603,
        tmdbType: 'movie',
        origin: 'manual',
        detail: null,
        createdByUserId: 1,
      },
    ]);
  });

  it('restores the old tables, empty, on the way down', async () => {
    await new RebuildMappingTables1789300000000().down(
      dataSource.createQueryRunner()
    );
    assert.deepEqual(await tables(), [
      'mapping_cluster',
      'mapping_episode_rule',
      'mapping_gap',
      'mapping_link',
      'mapping_override',
      'mapping_source',
      'mapping_source_usage',
    ]);
  });
});
