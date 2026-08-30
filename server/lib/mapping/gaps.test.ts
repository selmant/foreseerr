import { getRepository } from '@server/datasource';
import { MappingGap } from '@server/entity/MappingGap';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  flushMappingGaps,
  listMappingGaps,
  recordMappingGap,
  summarizeMappingGaps,
} from './gaps';
import { NO_SEASON } from './types';

setupTestDb();

beforeEach(async () => {
  await flushMappingGaps();
  await getRepository(MappingGap).clear();
});

describe('mapping gap telemetry', () => {
  it('folds repeat sightings into one row and counts every hit', async () => {
    for (let index = 0; index < 3; index += 1) {
      recordMappingGap({
        namespace: 'simkl',
        externalId: '2419656',
        title: 'Ore dake Level Up na Ken',
        discoverSource: 'simkl/trending/anime',
        reason: 'ambiguous',
      });
    }
    await flushMappingGaps();

    const rows = await getRepository(MappingGap).find();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].hitCount, 3);
    assert.equal(rows[0].season, NO_SEASON);
    assert.equal(rows[0].reason, 'ambiguous');
    assert.equal(rows[0].status, 'open');
  });

  it('accumulates across flushes rather than resetting the counter', async () => {
    recordMappingGap({ namespace: 'anilist', externalId: '176496' });
    await flushMappingGaps();
    recordMappingGap({ namespace: 'anilist', externalId: '176496' });
    recordMappingGap({ namespace: 'anilist', externalId: '176496' });
    await flushMappingGaps();

    const [row] = await getRepository(MappingGap).find();
    assert.equal(row.hitCount, 3);
  });

  it('keeps season-scoped sightings distinct', async () => {
    recordMappingGap({ namespace: 'trakt', externalId: 'song-of-the-samurai' });
    recordMappingGap({
      namespace: 'trakt',
      externalId: 'song-of-the-samurai',
      season: 2,
    });
    await flushMappingGaps();

    const rows = await getRepository(MappingGap).find();
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.season).sort((a, b) => a - b),
      [NO_SEASON, 2]
    );
  });

  it('ignores an observation with no external id', async () => {
    recordMappingGap({ namespace: 'simkl', externalId: '' });
    await flushMappingGaps();
    assert.equal(await getRepository(MappingGap).count(), 0);
  });

  it('ranks the repair queue by hit count and summarizes by reason', async () => {
    recordMappingGap({
      namespace: 'simkl',
      externalId: 'rare',
      discoverSource: 'simkl/trending/anime',
      reason: 'unresolved',
    });
    for (let index = 0; index < 5; index += 1) {
      recordMappingGap({
        namespace: 'simkl',
        externalId: 'popular',
        discoverSource: 'simkl/trending/anime',
        reason: 'ambiguous',
      });
    }
    await flushMappingGaps();

    const { results, total } = await listMappingGaps();
    assert.equal(total, 2);
    assert.equal(results[0].externalId, 'popular');

    const summary = await summarizeMappingGaps();
    assert.equal(summary.openGaps, 2);
    assert.equal(summary.totalHits, 6);
    assert.equal(summary.byReason.ambiguous, 1);
    assert.equal(summary.byReason.unresolved, 1);
    assert.equal(summary.bySource['simkl/trending/anime'], 2);
    assert.equal(summary.byNamespace.simkl, 2);
  });

  it('records the rejected target so a wrong-type can be audited', async () => {
    recordMappingGap({
      namespace: 'simkl',
      externalId: '39687',
      mediaType: 'tv',
      reason: 'wrong-type',
      rejectedTarget: 'tmdb_movie:313599',
      sourceKey: 'simkl:tmdb',
    });
    await flushMappingGaps();

    const [row] = await getRepository(MappingGap).find();
    assert.equal(row.rejectedTarget, 'tmdb_movie:313599');
    assert.equal(row.sourceKey, 'simkl:tmdb');
    assert.equal(row.mediaType, 'tv');
  });
});
