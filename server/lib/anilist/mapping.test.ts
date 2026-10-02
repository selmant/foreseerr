import { setupTestDb } from '@server/test/db';
import { edge, seedEdges } from '@server/test/mapping';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import anilistIdMapping, {
  fribbSeasonCandidates,
  pickFribbSeasonEntry,
} from './mapping';

setupTestDb();

describe('AniList entries of a TMDB show', () => {
  it('lists an entry once per season it runs through, with where it starts there', async () => {
    // Fullmetal Alchemist-shaped: one AniList entry over four TMDB seasons,
    // plus a special filed under season 0.
    await seedEdges([
      ...edge('tmdb_show:27660:s1', 'anilist:820', { '1-26': '1-26' }),
      ...edge('tmdb_show:27660:s2', 'anilist:820', { '1-26': '27-52' }),
      ...edge('tmdb_show:27660:s0', 'anilist:3014', { '1': '1' }),
    ]);
    const entries = await anilistIdMapping.getAnilistSeasonEntries('tv', 27660);
    assert.deepEqual(
      entries
        .map(({ anilistId, type, seasonTmdb, offsetTmdb }) => ({
          anilistId,
          type,
          seasonTmdb,
          offsetTmdb,
        }))
        .sort((a, b) => (a.seasonTmdb ?? 0) - (b.seasonTmdb ?? 0)),
      [
        { anilistId: 3014, type: 'SPECIAL', seasonTmdb: 0, offsetTmdb: 0 },
        { anilistId: 820, type: undefined, seasonTmdb: 1, offsetTmdb: 0 },
        { anilistId: 820, type: undefined, seasonTmdb: 2, offsetTmdb: -26 },
      ]
    );

    // Season 2 is found, and its first episode is the entry's 27th.
    assert.equal(fribbSeasonCandidates(entries, 2).entries.length, 1);
    assert.deepEqual(pickFribbSeasonEntry(entries, 2, 1)?.progress, 27);
  });

  it('takes a new season from the secondary dataset while the primary has the older ones', async () => {
    await seedEdges([
      ...edge('tmdb_show:9:s1', 'anilist:1'),
      ...edge('tmdb_show:9:s2', 'anilist:2'),
    ]);
    await seedEdges(
      [
        // Disagrees with the primary about season 1: ignored.
        ...edge('tmdb_show:9:s1', 'anilist:99'),
        // Season 3 only the secondary knows.
        ...edge('tmdb_show:9:s3', 'anilist:3'),
      ],
      'fribb'
    );
    assert.deepEqual(
      (await anilistIdMapping.getAnilistIds('tv', 9)).sort((a, b) => a - b),
      [1, 2, 3]
    );
  });
});
