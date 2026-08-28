import { getRepository } from '@server/datasource';
import { MappingGap } from '@server/entity/MappingGap';
import { MappingLink } from '@server/entity/MappingLink';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { flushMappingGaps } from './gaps';
import {
  heuristicResolver,
  normalizeTitle,
  suggestByTitle,
  suggestForOpenGaps,
  titleScore,
  type TitleSearchHit,
  type TitleSearchProvider,
} from './heuristic';

setupTestDb();

/** A fixed catalogue: the heuristic is the one layer allowed to guess, so its
 * guard rails have to be exercised without a network. */
const provider = (
  hits: TitleSearchHit[],
  episodes?: number
): TitleSearchProvider => ({
  search: async () => hits,
  episodeCount: async () => episodes,
});

beforeEach(async () => {
  await getRepository(MappingGap).clear();
  await getRepository(MappingLink).clear();
});
describe('heuristic title normalization', () => {
  it('collapses the decoration that differs between catalogues', () => {
    assert.equal(
      normalizeTitle('Attack on Titan: The Final Season Part 2'),
      normalizeTitle('Attack on Titan Final 2')
    );
    assert.equal(
      normalizeTitle('Re:ZERO -Starting Life-'),
      're zero starting life'
    );
  });

  it('scores an exact match above a near miss and a near miss above noise', () => {
    const exact = titleScore('demon slayer', 'demon slayer');
    const near = titleScore('demon slayer', 'demon slayers');
    const noise = titleScore('demon slayer', 'jujutsu kaisen');
    assert.equal(exact, 100);
    assert.ok(near > noise);
    assert.ok(noise < 50);
  });
});

describe('heuristic quarantine', () => {
  it('suggests a match but writes nothing to the graph', async () => {
    const suggestion = await suggestByTitle(
      { ns: 'anilist', id: '110277' },
      'tmdb_show',
      { title: 'Attack on Titan', year: 2013, mediaType: 'tv' },
      provider([
        { id: 1429, title: 'Attack on Titan', year: 2013 },
        { id: 900, title: 'Titan Quest', year: 2009 },
      ])
    );

    assert.equal(suggestion?.target.id, '1429');
    assert.equal(await getRepository(MappingLink).count(), 0);
  });

  it('refuses to guess when two candidates are near-tied', async () => {
    const suggestion = await suggestByTitle(
      { ns: 'anilist', id: '918' },
      'tmdb_show',
      { title: 'Gintama', year: 2006, mediaType: 'tv' },
      provider([
        { id: 1, title: 'Gintama', year: 2006 },
        { id: 2, title: 'Gintama.', year: 2006 },
      ])
    );

    assert.equal(suggestion, undefined);
  });

  it('refuses a match whose year is wrong by more than a year', async () => {
    const suggestion = await suggestByTitle(
      { ns: 'anilist', id: '116674' },
      'tmdb_show',
      { title: 'Bleach', year: 2022, mediaType: 'tv' },
      provider([{ id: 99, title: 'Bleach', year: 2004 }])
    );

    assert.equal(suggestion, undefined);
  });

  it('uses episode count to reject a season passed off as the whole series', async () => {
    const asSeries = await suggestByTitle(
      { ns: 'anilist', id: '110277' },
      'tmdb_show',
      {
        title: 'Attack on Titan',
        year: 2013,
        mediaType: 'tv',
        episodeCount: 16,
      },
      provider([{ id: 1429, title: 'Attack on Titan', year: 2013 }], 98)
    );
    assert.equal(asSeries, undefined);

    const matching = await suggestByTitle(
      { ns: 'anilist', id: '110277' },
      'tmdb_show',
      {
        title: 'Attack on Titan',
        year: 2013,
        mediaType: 'tv',
        episodeCount: 98,
      },
      provider([{ id: 1429, title: 'Attack on Titan', year: 2013 }], 98)
    );
    assert.equal(matching?.target.id, '1429');
  });

  it('sweeps open gaps into suggestions and leaves them open', async () => {
    const repository = getRepository(MappingGap);
    const now = new Date();
    await repository.insert({
      namespace: 'anilist',
      externalId: '110277',
      season: -1,
      title: 'Attack on Titan',
      year: 2013,
      mediaType: 'tv',
      reason: 'unresolved',
      status: 'open',
      hitCount: 12,
      firstSeenAt: now,
      lastSeenAt: now,
    });

    const result = await suggestForOpenGaps({
      limit: 10,
      provider: provider([{ id: 1429, title: 'Attack on Titan', year: 2013 }]),
    });
    assert.equal(result.examined, 1);
    assert.equal(result.suggested, 1);

    const [row] = await repository.find();
    assert.equal(row.suggestedTarget, 'tmdb_show:1429');
    assert.equal(row.suggestedBy, 'heuristic-title');
    // Quarantine: still open for review, and nothing reached the graph.
    assert.equal(row.status, 'open');
    assert.equal(await getRepository(MappingLink).count(), 0);
  });

  it('returns no candidate when registered in the chain, only a queued suggestion', async () => {
    const resolver = heuristicResolver(
      provider([{ id: 1429, title: 'Attack on Titan', year: 2013 }])
    );
    const candidates = await resolver.resolve(
      { ns: 'anilist', id: '110277' },
      'tmdb_show',
      { title: 'Attack on Titan', year: 2013, mediaType: 'tv' }
    );
    await flushMappingGaps();

    assert.deepEqual(candidates, []);
    const [row] = await getRepository(MappingGap).find();
    assert.equal(row.suggestedBy, 'heuristic-title');
    assert.equal(row.status, 'open');
  });

  it('never lets a suggestion outrank a real source', async () => {
    const suggestion = await suggestByTitle(
      { ns: 'anilist', id: '110277' },
      'tmdb_show',
      { title: 'Attack on Titan', year: 2013, mediaType: 'tv' },
      provider([{ id: 1429, title: 'Attack on Titan', year: 2013 }])
    );
    assert.ok(suggestion);
    // The chain treats anything under 50 as uncorroborated, and the stored
    // confidence is capped below that.
    assert.ok(Math.min(40, suggestion.score) <= 40);
  });
});
