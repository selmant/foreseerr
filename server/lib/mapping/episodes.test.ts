import type { TmdbTvEpisodeGroupDetails } from '@server/api/themoviedb/interfaces';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { compressToRules, rulesFromEpisodeGroup } from './episodeGroups';
import {
  absoluteFromSeasons,
  applyEpisodeRule,
  findEpisodeRules,
  invertEpisodeRule,
  parseEpisodeRange,
  seasonsFromAbsolute,
  translateEpisode,
  translateEpisodeBridged,
  translateEpisodeOnce,
  upsertEpisodeRule,
  type EpisodeRule,
} from './episodes';
import { upsertCluster } from './graph';
import mappingService from './service';
import type { IdRef } from './types';

setupTestDb();

beforeEach(() => {
  mappingService.invalidate();
});

const rule = (overrides: Partial<EpisodeRule> = {}): EpisodeRule => ({
  source: { ns: 'anidb', id: '19242' },
  target: { ns: 'tmdb_show', id: '65942', season: 1 },
  sourceRange: { start: 1, end: 15 },
  targetRange: { start: 67, end: 81 },
  ratio: 1,
  confidence: 90,
  sourceKey: 'anibridge',
  ...overrides,
});

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

describe('applying an episode rule', () => {
  it('offsets an episode inside the source range', () => {
    assert.equal(applyEpisodeRule(rule(), 1), 67);
    assert.equal(applyEpisodeRule(rule(), 15), 81);
  });

  it('refuses episodes outside the range', () => {
    assert.equal(applyEpisodeRule(rule(), 0), undefined);
    assert.equal(applyEpisodeRule(rule(), 16), undefined);
  });

  it('follows an open-ended range past its start', () => {
    const open = rule({
      sourceRange: { start: 14 },
      targetRange: { start: 14 },
    });
    assert.equal(applyEpisodeRule(open, 240), 240);
  });

  it('folds a 2:1 ratio', () => {
    const folded = rule({
      sourceRange: { start: 1, end: 24 },
      targetRange: { start: 1, end: 12 },
      ratio: 2,
    });
    assert.equal(applyEpisodeRule(folded, 1), 1);
    assert.equal(applyEpisodeRule(folded, 2), 1);
    assert.equal(applyEpisodeRule(folded, 3), 2);
  });

  it('reads a rule backwards', () => {
    const inverted = invertEpisodeRule(rule());
    assert.equal(applyEpisodeRule(inverted, 70), 4);
    assert.equal(applyEpisodeRule(inverted, 66), undefined);
  });

  it('inverts a fold to the first episode of the pair', () => {
    const inverted = invertEpisodeRule(
      rule({
        sourceRange: { start: 1, end: 24 },
        targetRange: { start: 1, end: 12 },
        ratio: 2,
      })
    );
    assert.equal(applyEpisodeRule(inverted, 1), 1);
    assert.equal(applyEpisodeRule(inverted, 2), 3);
  });
});

describe('absolute numbering', () => {
  const seasons = [
    { seasonNumber: 0, episodeCount: 5 },
    { seasonNumber: 1, episodeCount: 25 },
    { seasonNumber: 2, episodeCount: 12 },
    { seasonNumber: 3, episodeCount: 22 },
  ];

  it('ignores specials when counting forwards', () => {
    assert.equal(absoluteFromSeasons(seasons, 2, 1), 26);
    assert.equal(absoluteFromSeasons(seasons, 3, 5), 42);
  });

  it('refuses an episode past the season length', () => {
    assert.equal(absoluteFromSeasons(seasons, 2, 13), undefined);
  });

  it('round-trips through the inverse', () => {
    const absolute = absoluteFromSeasons(seasons, 3, 7);
    assert.ok(absolute);
    assert.deepEqual(seasonsFromAbsolute(seasons, absolute), {
      seasonNumber: 3,
      episodeNumber: 7,
    });
  });
});

describe('stored episode rules', () => {
  const anidb: IdRef = { ns: 'anidb', id: '19242' };
  const show: IdRef = { ns: 'tmdb_show', id: '65942', season: 1 };

  const seedRule = async (
    overrides: Partial<{
      sourceRange: string;
      targetRange: string;
      ratio: number;
      confidence: number;
      sourceKey: string;
    }> = {}
  ): Promise<number> => {
    const clusterId = await upsertCluster([
      { ref: anidb, confidence: 90, sourceKey: 'anibridge' },
      { ref: show, confidence: 90, sourceKey: 'anibridge' },
    ]);
    assert.ok(clusterId);
    await upsertEpisodeRule({
      clusterId,
      source: anidb,
      target: show,
      sourceRange: overrides.sourceRange ?? '1-15',
      targetRange: overrides.targetRange ?? '67-81',
      ratio: overrides.ratio ?? 1,
      confidence: overrides.confidence ?? 90,
      sourceKey: overrides.sourceKey ?? 'anibridge',
    });
    return clusterId;
  };

  it('translates forwards through a stored rule', async () => {
    await seedRule();

    const translated = await translateEpisodeOnce(
      { ...anidb, episode: 3 },
      'tmdb_show'
    );

    assert.equal(translated?.episode, 69);
    assert.equal(translated?.season, 1);
    assert.equal(translated?.target.ns, 'tmdb_show');
  });

  it('translates backwards without a second stored row', async () => {
    await seedRule();

    const translated = await translateEpisodeOnce(
      { ns: 'tmdb_show', id: '65942', season: 1, episode: 70 },
      'anidb'
    );

    assert.equal(translated?.episode, 4);
    assert.equal(translated?.target.id, '19242');
  });

  it('keeps the highest-confidence version of a row', async () => {
    const clusterId = await seedRule({ confidence: 40, sourceKey: 'fribb' });
    await upsertEpisodeRule({
      clusterId,
      source: anidb,
      target: show,
      sourceRange: '1-15',
      targetRange: '67-81',
      ratio: 1,
      confidence: 95,
      sourceKey: 'anibridge',
    });

    const rules = await findEpisodeRules(anidb, 'tmdb_show');
    assert.equal(rules.length, 1);
    assert.equal(rules[0].confidence, 95);
    assert.equal(rules[0].sourceKey, 'anibridge');
  });

  it('reports disagreement instead of picking a winner', async () => {
    const clusterId = await seedRule();
    await upsertEpisodeRule({
      clusterId,
      source: anidb,
      target: { ns: 'tmdb_show', id: '65942', season: 2 },
      sourceRange: '1-15',
      targetRange: '1-15',
      ratio: 1,
      confidence: 90,
      sourceKey: 'anime-lists',
    });

    const all = await translateEpisode({ ...anidb, episode: 3 }, 'tmdb_show');
    assert.equal(all.length, 2);
    assert.equal(
      await translateEpisodeOnce({ ...anidb, episode: 3 }, 'tmdb_show'),
      undefined
    );
  });

  it('does not answer a season-scoped question from another season', async () => {
    const clusterId = await upsertCluster([
      { ref: { ns: 'tmdb_show', id: '1429' }, confidence: 90, sourceKey: 'x' },
    ]);
    assert.ok(clusterId);
    await upsertEpisodeRule({
      clusterId,
      source: { ns: 'tmdb_show', id: '1429', season: 4 },
      target: { ns: 'anidb', id: '999' },
      sourceRange: '1-16',
      targetRange: '1-16',
      ratio: 1,
      confidence: 90,
      sourceKey: 'anibridge',
    });

    const wrongSeason = await findEpisodeRules(
      { ns: 'tmdb_show', id: '1429', season: 3 },
      'anidb'
    );
    const rightSeason = await findEpisodeRules(
      { ns: 'tmdb_show', id: '1429', season: 4 },
      'anidb'
    );

    assert.equal(wrongSeason.length, 0);
    assert.equal(rightSeason.length, 1);
  });
});

describe('bridged episode translation', () => {
  it('returns the target season when it differs from the hop', async () => {
    const anilist: IdRef = { ns: 'anilist', id: '110277' };
    const anidb: IdRef = { ns: 'anidb', id: '8142', season: 1 };
    const tvdb: IdRef = { ns: 'tvdb_show', id: '267440', season: 2 };
    const clusterId = await upsertCluster([
      { ref: anilist, confidence: 90, sourceKey: 'anime-lists' },
      { ref: anidb, confidence: 90, sourceKey: 'anime-lists' },
      { ref: tvdb, confidence: 90, sourceKey: 'anime-lists' },
    ]);
    assert.ok(clusterId);
    await upsertEpisodeRule({
      clusterId,
      source: anilist,
      target: anidb,
      sourceRange: '1-12',
      targetRange: '1-12',
      ratio: 1,
      confidence: 90,
      sourceKey: 'anime-lists',
    });
    mappingService.register({
      key: 'bridge-season-test',
      kind: 'pack',
      trust: 80,
      supports: (from, to) => from.ns === 'anidb' && to === 'tvdb_show',
      resolve: async () => [
        {
          target: tvdb,
          confidence: 80,
          sourceKey: 'anime-lists',
        },
      ],
    });

    try {
      const translated = await translateEpisodeBridged(
        { ...anilist, episode: 3 },
        'tvdb_show',
        ['anidb']
      );
      assert.equal(translated?.episode, 3);
      assert.equal(translated?.season, 2);
      assert.equal(translated?.target.season, 2);
      assert.equal(translated?.target.ns, 'tvdb_show');
    } finally {
      mappingService.unregister('bridge-season-test');
    }
  });
});

describe('TMDB episode groups', () => {
  it('compresses a contiguous run into a single rule', () => {
    const rules = compressToRules(
      Array.from({ length: 25 }, (_, index) => ({
        order: index + 1,
        season: 1,
        episode: index + 1,
      })),
      1
    );

    assert.equal(rules.length, 1);
    assert.equal(rules[0].sourceRange, '1-25');
    assert.equal(rules[0].targetRange, '1-25');
  });

  it('splits a run where the season changes', () => {
    const rules = compressToRules(
      [
        { order: 1, season: 1, episode: 1 },
        { order: 2, season: 1, episode: 2 },
        { order: 3, season: 2, episode: 1 },
      ],
      1
    );

    assert.deepEqual(
      rules.map((entry) => [
        entry.sourceRange,
        entry.targetSeason,
        entry.targetRange,
      ]),
      [
        ['1-2', 1, '1-2'],
        ['3', 2, '1'],
      ]
    );
  });

  it('treats an absolute-order group as one stream', () => {
    const details: TmdbTvEpisodeGroupDetails = {
      id: 'abc',
      name: 'Absolute',
      episode_count: 4,
      group_count: 1,
      type: 2,
      groups: [
        {
          id: 'g1',
          name: 'Absolute',
          order: 0,
          episodes: [
            { id: 1, order: 0, season_number: 1, episode_number: 1 },
            { id: 2, order: 1, season_number: 1, episode_number: 2 },
            { id: 3, order: 2, season_number: 2, episode_number: 1 },
            { id: 4, order: 3, season_number: 2, episode_number: 2 },
          ],
        },
      ],
    };

    const rules = rulesFromEpisodeGroup(details);

    assert.deepEqual(
      rules.map((entry) => [
        entry.sourceSeason,
        entry.sourceRange,
        entry.targetSeason,
        entry.targetRange,
      ]),
      [
        [1, '1-2', 1, '1-2'],
        [1, '3-4', 2, '1-2'],
      ]
    );
  });

  it('numbers non-absolute groups by their position', () => {
    const details: TmdbTvEpisodeGroupDetails = {
      id: 'abc',
      name: 'DVD',
      episode_count: 2,
      group_count: 2,
      type: 3,
      groups: [
        {
          id: 'g1',
          name: 'Season 1',
          order: 0,
          episodes: [{ id: 1, order: 0, season_number: 1, episode_number: 1 }],
        },
        {
          id: 'g2',
          name: 'Season 2',
          order: 1,
          episodes: [{ id: 2, order: 0, season_number: 1, episode_number: 14 }],
        },
      ],
    };

    const rules = rulesFromEpisodeGroup(details);

    assert.deepEqual(
      rules.map((entry) => [entry.sourceSeason, entry.targetRange]),
      [
        [1, '1'],
        [2, '14'],
      ]
    );
  });
});
