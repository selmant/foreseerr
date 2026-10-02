import { setupTestDb } from '@server/test/db';
import { edge, seedEdges } from '@server/test/mapping';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyEpisodeRule,
  findEpisodeRules,
  parseEpisodeRange,
  parseRangePair,
  translateEpisode,
  translateEpisodeBridged,
  translateEpisodeOnce,
} from './episodes';

setupTestDb();

describe('episode range parsing', () => {
  it('parses closed, open, and single ranges', () => {
    assert.deepEqual(parseEpisodeRange('1-13'), { start: 1, end: 13 });
    assert.deepEqual(parseEpisodeRange('13-'), { start: 13 });
    assert.deepEqual(parseEpisodeRange('5'), { start: 5, end: 5 });
    assert.deepEqual(parseEpisodeRange('-13'), { start: 1, end: 13 });
  });

  it('rejects nonsense rather than guessing', () => {
    assert.equal(parseEpisodeRange(''), undefined);
    assert.equal(parseEpisodeRange('abc'), undefined);
    assert.equal(parseEpisodeRange('13-2'), undefined);
  });
});

describe('range pairs', () => {
  const apply = (source: string, target: string, episode: number) =>
    parseRangePair(source, target)
      .map((rule) => applyEpisodeRule(rule, episode))
      .find((mapped) => mapped !== undefined);

  it('offsets an episode inside the source range', () => {
    assert.equal(apply('1-15', '67-81', 1), 67);
    assert.equal(apply('1-15', '67-81', 15), 81);
    assert.equal(apply('1-15', '67-81', 16), undefined);
  });

  it('follows an open-ended range past its start', () => {
    assert.equal(apply('14-', '14-', 240), 240);
  });

  it('folds a positive ratio: two source episodes per target', () => {
    assert.equal(apply('1-4', '1-2|2', 1), 1);
    assert.equal(apply('1-4', '1-2|2', 2), 1);
    assert.equal(apply('1-4', '1-2|2', 3), 2);
  });

  it('expands a negative ratio to the first target episode', () => {
    assert.equal(apply('1-3', '1-12|-4', 1), 1);
    assert.equal(apply('1-3', '1-12|-4', 2), 5);
    assert.equal(apply('1-3', '1-12|-4', 3), 9);
  });

  it('fills discontiguous target runs from the source range in order', () => {
    // 15 episodes, a gap at 16, six more, a gap at 23, then three.
    assert.equal(apply('1-24', '1-15,17-22,24-26', 15), 15);
    assert.equal(apply('1-24', '1-15,17-22,24-26', 16), 17);
    assert.equal(apply('1-24', '1-15,17-22,24-26', 21), 22);
    assert.equal(apply('1-24', '1-15,17-22,24-26', 22), 24);
  });

  it('drops a pair it cannot read instead of guessing', () => {
    assert.deepEqual(parseRangePair('abc', '1-3'), []);
    assert.deepEqual(parseRangePair('1-4', '66-68,70-75|-3'), []);
  });
});

describe('episode translation over dataset edges', () => {
  it('translates through the season it was asked about only', async () => {
    await seedEdges([
      ...edge('tmdb_show:1429:s1', 'anilist:16498', { '1-25': '1-25' }),
      ...edge('tmdb_show:1429:s2', 'anilist:20958', { '1-12': '1-12' }),
    ]);
    const first = await translateEpisodeOnce(
      { ns: 'tmdb_show', id: '1429', season: 1, episode: 3 },
      'anilist'
    );
    assert.equal(first?.target.id, '16498');
    assert.equal(first?.episode, 3);

    const second = await translateEpisodeOnce(
      { ns: 'tmdb_show', id: '1429', season: 2, episode: 3 },
      'anilist'
    );
    assert.equal(second?.target.id, '20958');
  });

  it('picks the entry whose range covers the episode in a multi-cour season', async () => {
    await seedEdges([
      ...edge('tmdb_show:95479:s1', 'anilist:113415', { '1-24': '1-24' }),
      ...edge('tmdb_show:95479:s1', 'anilist:145064', { '25-47': '1-23' }),
    ]);
    const late = await translateEpisodeOnce(
      { ns: 'tmdb_show', id: '95479', season: 1, episode: 30 },
      'anilist'
    );
    assert.equal(late?.target.id, '145064');
    assert.equal(late?.episode, 6);
  });

  it('carries the target season on a season-to-season translation', async () => {
    await seedEdges(
      edge('tmdb_show:1429:s1', 'tvdb_show:267440:s3', { '38-59': '1-22' })
    );
    const rules = await findEpisodeRules(
      { ns: 'tmdb_show', id: '1429', season: 1 },
      'tvdb_show'
    );
    assert.equal(rules[0].target.season, 3);
    const translated = await translateEpisodeOnce(
      { ns: 'tmdb_show', id: '1429', season: 1, episode: 40 },
      'tvdb_show'
    );
    assert.deepEqual([translated?.season, translated?.episode], [3, 3]);
  });

  it('reports disagreement instead of picking a winner', async () => {
    await seedEdges([
      ...edge('tmdb_show:7:s1', 'anilist:100', { '1-12': '1-12' }),
      ...edge('tmdb_show:7:s1', 'anilist:200', { '1-12': '1-12' }),
    ]);
    const from = { ns: 'tmdb_show' as const, id: '7', season: 1, episode: 2 };
    assert.equal((await translateEpisode(from, 'anilist')).length, 2);
    assert.equal(await translateEpisodeOnce(from, 'anilist'), undefined);
  });

  it('bridges through the anime entry when no direct range exists', async () => {
    await seedEdges([
      ...edge('tmdb_show:1429:s1', 'anidb:9541:R', { '1-25': '1-25' }),
      ...edge('anidb:9541:R', 'tvdb_show:267440:s1', { '1-25': '1-25' }),
      // The specials scope of the same AniDB id must not be used for the hop.
      ...edge('anidb:9541:S', 'tvdb_show:267440:s0', { '1-25': '1-25' }),
    ]);
    const from = {
      ns: 'tmdb_show' as const,
      id: '1429',
      season: 1,
      episode: 4,
    };
    assert.equal(await translateEpisodeOnce(from, 'tvdb_show'), undefined);
    const bridged = await translateEpisodeBridged(from, 'tvdb_show', ['anidb']);
    assert.equal(bridged?.target.id, '267440');
    assert.deepEqual([bridged?.season, bridged?.episode], [1, 4]);
  });

  it('prefers the primary dataset when both state a range', async () => {
    await seedEdges(
      edge('tmdb_show:9:s1', 'anilist:1', { '1-12': '1-12' }),
      'anibridge'
    );
    await seedEdges(
      edge('tmdb_show:9:s1', 'anilist:2', { '1-': '1-' }),
      'fribb'
    );
    const translated = await translateEpisodeOnce(
      { ns: 'tmdb_show', id: '9', season: 1, episode: 5 },
      'anilist'
    );
    assert.equal(translated?.target.id, '1');
  });
});
