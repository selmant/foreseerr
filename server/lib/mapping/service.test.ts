import { getRepository } from '@server/datasource';
import { MappingCluster } from '@server/entity/MappingCluster';
import { MappingEpisodeRule } from '@server/entity/MappingEpisodeRule';
import { MappingGap } from '@server/entity/MappingGap';
import { MappingLink } from '@server/entity/MappingLink';
import { MappingOverride } from '@server/entity/MappingOverride';
import { MappingSource } from '@server/entity/MappingSource';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { flushMappingGaps } from './gaps';
import {
  beginPackGraphRewrite,
  endPackGraphRewrite,
  loadMappingSourceEnabledState,
  mappingSourceContributes,
  resetMappingSourceEnabledState,
  resolveFromGraph,
  retractPackFromGraph,
  setMappingSourceEnabled,
  upsertCluster,
} from './graph';
import { BoundedLru } from './lru';
import { MappingService } from './service';
import type { IdRef, MappingResolver } from './types';

setupTestDb();

beforeEach(async () => {
  resetMappingSourceEnabledState();
  await flushMappingGaps();
  for (const entity of [
    MappingEpisodeRule,
    MappingLink,
    MappingCluster,
    MappingOverride,
    MappingGap,
    MappingSource,
  ]) {
    await getRepository(entity).clear();
  }
});

const packResolver = (
  key: string,
  answers: Record<string, IdRef[]>,
  trust = 70
): MappingResolver => ({
  key,
  kind: 'pack',
  trust,
  supports: () => true,
  resolve: async (from, to) => {
    const found = answers[`${from.ns}:${from.id}->${to}`] ?? [];
    return found.map((target) => ({
      target,
      confidence: trust,
      sourceKey: key,
    }));
  },
});

describe('bounded LRU hot cache', () => {
  it('evicts the least recently used entry at the cap', () => {
    const lru = new BoundedLru<string, number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    assert.equal(lru.get('a'), 1);
    lru.set('c', 3);
    assert.equal(lru.size, 2);
    assert.equal(lru.get('b'), undefined, 'b was least recently used');
    assert.equal(lru.get('a'), 1);
    assert.equal(lru.get('c'), 3);
  });

  it('expires entries past their TTL', async () => {
    const lru = new BoundedLru<string, number>(4, 1);
    lru.set('a', 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(lru.get('a'), undefined);
  });
});

describe('mapping graph', () => {
  it('links several namespaces to one cluster and resolves between them', async () => {
    await upsertCluster(
      [
        {
          ref: { ns: 'anilist', id: '16498' },
          confidence: 90,
          sourceKey: 'anibridge',
        },
        {
          ref: { ns: 'anidb', id: '9541' },
          confidence: 90,
          sourceKey: 'anibridge',
        },
        {
          ref: { ns: 'tmdb_show', id: '1429', season: 1 },
          confidence: 90,
          sourceKey: 'anibridge',
        },
      ],
      { title: 'Shingeki no Kyojin' }
    );

    const candidates = await resolveFromGraph(
      { ns: 'anilist', id: '16498' },
      'tmdb_show'
    );
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].target.id, '1429');
    assert.equal(candidates[0].target.season, 1);
    assert.equal(candidates[0].sourceKey, 'anibridge');
  });

  it('does not merge a movie work into an existing series cluster', async () => {
    await upsertCluster([
      {
        ref: { ns: 'anilist', id: '21519' },
        confidence: 90,
        sourceKey: 'anibridge',
      },
      {
        ref: { ns: 'tmdb_show', id: '372058' },
        confidence: 90,
        sourceKey: 'anibridge',
      },
    ]);
    await upsertCluster([
      {
        ref: { ns: 'anilist', id: '21519' },
        confidence: 80,
        sourceKey: 'animeapi',
      },
      {
        ref: { ns: 'tmdb_movie', id: '372058' },
        confidence: 80,
        sourceKey: 'animeapi',
      },
    ]);

    assert.equal(await getRepository(MappingCluster).count(), 2);
    const movies = await resolveFromGraph(
      { ns: 'anilist', id: '21519' },
      'tmdb_movie'
    );
    assert.equal(movies.length, 1);
    assert.equal(movies[0].target.ns, 'tmdb_movie');
    assert.equal(movies[0].target.id, '372058');
  });

  it('does not union two series that share anidb but disagree on TMDB', async () => {
    await upsertCluster([
      {
        ref: { ns: 'anilist', id: '21' },
        confidence: 90,
        sourceKey: 'anibridge',
      },
      {
        ref: { ns: 'anidb', id: '69' },
        confidence: 90,
        sourceKey: 'anibridge',
      },
      {
        ref: { ns: 'tmdb_show', id: '378214' },
        confidence: 90,
        sourceKey: 'anibridge',
      },
    ]);
    await upsertCluster([
      {
        ref: { ns: 'anilist', id: '269' },
        confidence: 90,
        sourceKey: 'anibridge',
      },
      {
        ref: { ns: 'anidb', id: '69' },
        confidence: 90,
        sourceKey: 'anibridge',
      },
      {
        ref: { ns: 'tmdb_show', id: '30984' },
        confidence: 90,
        sourceKey: 'anibridge',
      },
    ]);

    const onePiece = await resolveFromGraph(
      { ns: 'anilist', id: '21' },
      'tmdb_show'
    );
    assert.equal(onePiece.length, 1);
    assert.equal(onePiece[0].target.id, '378214');
    const bleach = await resolveFromGraph(
      { ns: 'anilist', id: '269' },
      'tmdb_show'
    );
    assert.equal(bleach.length, 1);
    assert.equal(bleach[0].target.id, '30984');
  });

  it('keeps colliding seasons of one TMDB id in separate clusters', async () => {
    await upsertCluster([
      {
        ref: { ns: 'anidb', id: '9541' },
        confidence: 90,
        sourceKey: 'anibridge',
      },
      {
        ref: { ns: 'tmdb_show', id: '1429', season: 1 },
        confidence: 90,
        sourceKey: 'anibridge',
      },
    ]);
    await upsertCluster([
      {
        ref: { ns: 'anidb', id: '14977' },
        confidence: 90,
        sourceKey: 'anibridge',
      },
      {
        ref: { ns: 'tmdb_show', id: '1429', season: 4 },
        confidence: 90,
        sourceKey: 'anibridge',
      },
    ]);

    assert.equal(await getRepository(MappingCluster).count(), 2);

    const season4 = await resolveFromGraph(
      { ns: 'anidb', id: '14977' },
      'tmdb_show'
    );
    assert.deepEqual(
      season4.map((candidate) => candidate.target.season),
      [4]
    );

    // Asking about one season of the shared id must not surface the other.
    const fromSeason1 = await resolveFromGraph(
      { ns: 'tmdb_show', id: '1429', season: 1 },
      'anidb'
    );
    assert.deepEqual(
      fromSeason1.map((candidate) => candidate.target.id),
      ['9541']
    );
  });

  it('merges into an existing cluster instead of forking a duplicate', async () => {
    await upsertCluster([
      {
        ref: { ns: 'anilist', id: '16498' },
        confidence: 80,
        sourceKey: 'fribb',
      },
    ]);
    await upsertCluster([
      {
        ref: { ns: 'anilist', id: '16498' },
        confidence: 90,
        sourceKey: 'anibridge',
      },
      {
        ref: { ns: 'imdb', id: 'tt2560140' },
        confidence: 90,
        sourceKey: 'anibridge',
      },
    ]);

    assert.equal(await getRepository(MappingCluster).count(), 1);
    const [link] = await getRepository(MappingLink).find({
      where: { namespace: 'anilist' },
    });
    assert.equal(link.confidence, 90, 'higher-confidence source wins');
    assert.equal(link.sourceKey, 'anibridge');
  });

  it('never downgrades a stored link', async () => {
    await upsertCluster([
      {
        ref: { ns: 'anilist', id: '1' },
        confidence: 95,
        sourceKey: 'anibridge',
      },
    ]);
    await upsertCluster([
      { ref: { ns: 'anilist', id: '1' }, confidence: 30, sourceKey: 'guess' },
    ]);
    const [link] = await getRepository(MappingLink).find();
    assert.equal(link.confidence, 95);
    assert.equal(link.sourceKey, 'anibridge');
  });
});

describe('mapping service resolver chain', () => {
  it('prefers an admin override over every other layer', async () => {
    const service = new MappingService();
    service.register(
      packResolver('anibridge', {
        'trakt:mad-max->tmdb_movie': [{ ns: 'tmdb_movie', id: '434021' }],
      })
    );
    await getRepository(MappingOverride).insert({
      fromNamespace: 'trakt',
      fromExternalId: 'mad-max',
      fromSeason: -1,
      toNamespace: 'tmdb_movie',
      toExternalId: '76341',
      toSeason: -1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const resolution = await service.resolve(
      { ns: 'trakt', id: 'mad-max' },
      'tmdb_movie'
    );
    assert.equal(resolution.layer, 'override');
    assert.equal(resolution.target?.id, '76341');
    assert.equal(resolution.confidence, 100);
  });

  it('treats an empty override target as a recorded absence and stops the chain', async () => {
    const service = new MappingService();
    let packCalls = 0;
    service.register({
      key: 'anibridge',
      kind: 'pack',
      trust: 70,
      supports: () => true,
      resolve: async () => {
        packCalls += 1;
        return [
          {
            target: { ns: 'tmdb_show', id: '9' },
            confidence: 70,
            sourceKey: 'anibridge',
          },
        ];
      },
    });
    await getRepository(MappingOverride).insert({
      fromNamespace: 'simkl',
      fromExternalId: '123',
      fromSeason: -1,
      toNamespace: 'tmdb_show',
      toExternalId: '',
      toSeason: -1,
      note: 'Chinese donghua, genuinely absent from TMDB',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const resolution = await service.resolve(
      { ns: 'simkl', id: '123' },
      'tmdb_show'
    );
    assert.equal(resolution.target, undefined);
    assert.equal(resolution.layer, 'override');
    assert.equal(packCalls, 0);
  });

  it('persists a pack result so the next lookup is served from the graph', async () => {
    const service = new MappingService();
    let packCalls = 0;
    service.register({
      key: 'anibridge',
      kind: 'pack',
      trust: 90,
      supports: () => true,
      resolve: async () => {
        packCalls += 1;
        return [
          {
            target: { ns: 'tmdb_show', id: '1429', season: 4 },
            confidence: 90,
            sourceKey: 'anibridge',
          },
        ];
      },
    });

    const first = await service.resolve(
      { ns: 'anidb', id: '14977' },
      'tmdb_show'
    );
    assert.equal(first.layer, 'pack');
    assert.equal(first.target?.id, '1429');
    assert.equal(packCalls, 1);

    service.invalidate();
    const second = await service.resolve(
      { ns: 'anidb', id: '14977' },
      'tmdb_show'
    );
    assert.equal(second.layer, 'graph');
    assert.equal(second.target?.season, 4);
    assert.equal(packCalls, 1, 'pack must not be re-queried after persistence');
  });

  it('serves a repeat lookup from the hot cache without touching a resolver', async () => {
    const service = new MappingService();
    let calls = 0;
    service.register({
      key: 'anibridge',
      kind: 'pack',
      trust: 90,
      supports: () => true,
      resolve: async () => {
        calls += 1;
        return [
          {
            target: { ns: 'tmdb_show', id: '5' },
            confidence: 90,
            sourceKey: 'anibridge',
          },
        ];
      },
    });

    await service.resolve({ ns: 'anilist', id: '7' }, 'tmdb_show');
    await service.resolve({ ns: 'anilist', id: '7' }, 'tmdb_show');
    assert.equal(calls, 1);
  });

  it('reports disagreeing candidates as ambiguous rather than picking one', async () => {
    const service = new MappingService();
    service.register(
      packResolver(
        'anibridge',
        {
          'trakt:song-of-the-samurai->tmdb_show': [
            { ns: 'tmdb_show', id: '302162' },
          ],
        },
        90
      )
    );
    service.register(
      packResolver(
        'fribb',
        {
          'trakt:song-of-the-samurai->tmdb_show': [
            { ns: 'tmdb_show', id: '320340' },
          ],
        },
        60
      )
    );

    const resolution = await service.resolve(
      { ns: 'trakt', id: 'song-of-the-samurai' },
      'tmdb_show',
      { discoverSource: 'trakt/list' }
    );
    assert.equal(resolution.ambiguous, true);
    assert.equal(resolution.target, undefined);
    assert.equal(resolution.candidates.length, 2);
    assert.equal(await getRepository(MappingLink).count(), 0);

    await flushMappingGaps();
    const [gap] = await getRepository(MappingGap).find();
    assert.equal(gap.reason, 'ambiguous');
    assert.equal(gap.discoverSource, 'trakt/list');
  });

  it('keeps a graph cour split as ambiguous when lower layers find nothing', async () => {
    await upsertCluster([
      {
        ref: { ns: 'trakt', id: 'song-of-the-samurai' },
        confidence: 80,
        sourceKey: 'a',
      },
      {
        ref: { ns: 'tmdb_show', id: '302162' },
        confidence: 80,
        sourceKey: 'a',
      },
    ]);
    await upsertCluster([
      {
        ref: { ns: 'trakt', id: 'song-of-the-samurai' },
        confidence: 80,
        sourceKey: 'b',
      },
      {
        ref: { ns: 'tmdb_show', id: '320340' },
        confidence: 80,
        sourceKey: 'b',
      },
    ]);

    const service = new MappingService();
    const resolution = await service.resolve(
      { ns: 'trakt', id: 'song-of-the-samurai' },
      'tmdb_show'
    );
    assert.equal(resolution.ambiguous, true);
    assert.equal(resolution.target, undefined);
    assert.equal(resolution.layer, 'graph');
  });

  it('does not reuse a silent miss to skip later gap recording', async () => {
    const service = new MappingService();
    await service.resolve({ ns: 'anilist', id: '404' }, 'tmdb_show', {
      silent: true,
    });
    await service.resolve({ ns: 'anilist', id: '404' }, 'tmdb_show', {
      discoverSource: 'trakt/list',
    });
    await flushMappingGaps();
    const gap = await getRepository(MappingGap).findOne({
      where: { externalId: '404' },
    });
    assert.equal(gap?.reason, 'unresolved');
  });

  it('hides disabled-source graph links immediately', async () => {
    await upsertCluster([
      {
        ref: { ns: 'anilist', id: '1' },
        confidence: 90,
        sourceKey: 'anibridge',
      },
      {
        ref: { ns: 'tmdb_show', id: '9' },
        confidence: 90,
        sourceKey: 'anibridge',
      },
    ]);
    setMappingSourceEnabled('anibridge', false);
    const candidates = await resolveFromGraph(
      { ns: 'anilist', id: '1' },
      'tmdb_show'
    );
    assert.equal(candidates.length, 0);
  });

  it('does not let an in-flight reload overwrite a newer disable', async () => {
    const repository = getRepository(MappingSource);
    const originalFind = repository.find.bind(repository);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    repository.find = async (...args) => {
      await gate;
      return originalFind(...args);
    };

    try {
      const loading = loadMappingSourceEnabledState({ force: true });
      setMappingSourceEnabled('anibridge', false);
      assert.equal(mappingSourceContributes('anibridge'), false);
      release();
      await loading;
      assert.equal(mappingSourceContributes('anibridge'), false);
    } finally {
      repository.find = originalFind;
    }
  });

  it('collapses season-scoped links of one show into a single answer', async () => {
    // anibridge stores one edge per cour (`tmdb_show:82684:s1` … `:s4`). Those
    // are the same work; treating them as four disagreeing candidates is what
    // made getFromAnilistId fall through to a colliding tmdb_movie id.
    const service = new MappingService();
    service.register(
      packResolver('anibridge', {
        'anilist:182205->tmdb_show': [
          { ns: 'tmdb_show', id: '82684', season: 1 },
          { ns: 'tmdb_show', id: '82684', season: 4 },
        ],
      })
    );

    const resolution = await service.resolve(
      { ns: 'anilist', id: '182205' },
      'tmdb_show'
    );
    assert.equal(resolution.ambiguous, false);
    assert.equal(resolution.target?.id, '82684');
    assert.equal(resolution.candidates.length, 1);
  });

  it('prefers a whole-work TMDB link over a stray season-0 franchise hitchhiker', async () => {
    // Live Bleach (anilist 269): cluster also held Clannad as tmdb_show:24835:s0
    // with no season-less edge. Discover must keep Bleach, not go unmapped.
    await upsertCluster([
      {
        ref: { ns: 'anilist', id: '269' },
        confidence: 95,
        sourceKey: 'anibridge',
      },
      {
        ref: { ns: 'tmdb_show', id: '30984', season: 1 },
        confidence: 90,
        sourceKey: 'anibridge',
      },
      {
        ref: { ns: 'tmdb_show', id: '30984' },
        confidence: 70,
        sourceKey: 'animeapi',
      },
      {
        ref: { ns: 'tmdb_show', id: '24835', season: 0 },
        confidence: 90,
        sourceKey: 'anibridge',
      },
    ]);

    const service = new MappingService();
    const resolution = await service.resolve(
      { ns: 'anilist', id: '269' },
      'tmdb_show'
    );
    assert.equal(resolution.ambiguous, false);
    assert.equal(resolution.target?.id, '30984');
  });

  it('picks the higher-confidence work when a franchise cluster has two bare TMDB ids', async () => {
    // Live Gintama (anilist 918): main series 57041@90 vs Semi-Final 114211@70.
    await upsertCluster([
      {
        ref: { ns: 'anilist', id: '918' },
        confidence: 95,
        sourceKey: 'anibridge',
      },
      {
        ref: { ns: 'tmdb_show', id: '57041', season: 1 },
        confidence: 90,
        sourceKey: 'anibridge',
      },
      {
        ref: { ns: 'tmdb_show', id: '57041' },
        confidence: 70,
        sourceKey: 'animeapi',
      },
      {
        ref: { ns: 'tmdb_show', id: '114211' },
        confidence: 70,
        sourceKey: 'animeapi',
      },
    ]);

    const service = new MappingService();
    const resolution = await service.resolve(
      { ns: 'anilist', id: '918' },
      'tmdb_show'
    );
    assert.equal(resolution.ambiguous, false);
    assert.equal(resolution.target?.id, '57041');
  });

  it('accepts a corroborated candidate when two sources agree', async () => {
    const service = new MappingService();
    service.register(
      packResolver(
        'anibridge',
        { 'anilist:16498->tmdb_show': [{ ns: 'tmdb_show', id: '1429' }] },
        90
      )
    );
    service.register(
      packResolver(
        'animeapi',
        { 'anilist:16498->tmdb_show': [{ ns: 'tmdb_show', id: '1429' }] },
        60
      )
    );

    const resolution = await service.resolve(
      { ns: 'anilist', id: '16498' },
      'tmdb_show'
    );
    assert.equal(resolution.ambiguous, false);
    assert.equal(resolution.target?.id, '1429');
    // Agreeing sources collapse to one work; the point is we accept it.
    assert.equal(resolution.candidates.length, 1);
  });

  it('quarantines a heuristic answer and never writes it to the graph', async () => {
    const service = new MappingService();
    service.register({
      key: 'title-year',
      kind: 'heuristic',
      trust: 20,
      supports: () => true,
      resolve: async () => [
        {
          target: { ns: 'tmdb_movie', id: '99999' },
          confidence: 20,
          sourceKey: 'title-year',
        },
      ],
    });

    const resolution = await service.resolve(
      { ns: 'trakt', id: 'rdr2' },
      'tmdb_movie'
    );
    assert.equal(resolution.layer, 'heuristic');
    assert.equal(resolution.target, undefined, 'heuristics are not trusted');
    assert.equal(resolution.candidates[0].target.id, '99999');
    assert.equal(await getRepository(MappingLink).count(), 0);
  });

  it('skips live resolvers when offline and still serves the graph', async () => {
    const service = new MappingService();
    let liveCalls = 0;
    service.register({
      key: 'simkl',
      kind: 'live',
      trust: 80,
      supports: () => true,
      resolve: async () => {
        liveCalls += 1;
        return [
          {
            target: { ns: 'tmdb_show', id: '1' },
            confidence: 80,
            sourceKey: 'simkl',
          },
        ];
      },
    });
    await upsertCluster([
      {
        ref: { ns: 'anilist', id: '42' },
        confidence: 90,
        sourceKey: 'anibridge',
      },
      {
        ref: { ns: 'tmdb_show', id: '77' },
        confidence: 90,
        sourceKey: 'anibridge',
      },
    ]);

    const resolution = await service.resolve(
      { ns: 'anilist', id: '42' },
      'tmdb_show',
      { offline: true }
    );
    assert.equal(resolution.target?.id, '77');
    assert.equal(liveCalls, 0);

    const miss = await service.resolve(
      { ns: 'anilist', id: '43' },
      'tmdb_show',
      { offline: true }
    );
    assert.equal(miss.target, undefined);
    assert.equal(liveCalls, 0);
  });

  it('records a gap when nothing resolves', async () => {
    const service = new MappingService();
    const resolution = await service.resolve(
      { ns: 'simkl', id: '2419656' },
      'tmdb_show',
      { discoverSource: 'simkl/trending/anime', title: 'Solo Leveling' }
    );
    assert.equal(resolution.layer, 'none');
    await flushMappingGaps();
    const [gap] = await getRepository(MappingGap).find();
    assert.equal(gap.externalId, '2419656');
    assert.equal(gap.reason, 'unresolved');
    assert.equal(gap.title, 'Solo Leveling');
  });

  it('answers an identity query without consulting any resolver', async () => {
    const service = new MappingService();
    let calls = 0;
    service.register({
      key: 'never',
      kind: 'pack',
      trust: 90,
      supports: () => {
        calls += 1;
        return true;
      },
      resolve: async () => [],
    });
    const resolution = await service.resolve(
      { ns: 'tmdb_show', id: '1429' },
      'tmdb_show'
    );
    assert.equal(resolution.target?.id, '1429');
    assert.equal(calls, 0);
  });
});

describe('pack graph retract', () => {
  it('lets a later pack ingest replace the stored TMDB target', async () => {
    await upsertCluster([
      {
        ref: { ns: 'anilist', id: '1' },
        confidence: 90,
        sourceKey: 'anibridge',
      },
      {
        ref: { ns: 'tmdb_show', id: '111' },
        confidence: 90,
        sourceKey: 'anibridge',
      },
    ]);

    await retractPackFromGraph('anibridge');
    await upsertCluster([
      {
        ref: { ns: 'anilist', id: '1' },
        confidence: 90,
        sourceKey: 'anibridge',
      },
      {
        ref: { ns: 'tmdb_show', id: '222' },
        confidence: 90,
        sourceKey: 'anibridge',
      },
    ]);

    const candidates = await resolveFromGraph(
      { ns: 'anilist', id: '1' },
      'tmdb_show'
    );
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].target.id, '222');
  });

  it('leaves live-sourced links when a pack is retracted', async () => {
    await upsertCluster([
      {
        ref: { ns: 'anilist', id: '1' },
        confidence: 90,
        sourceKey: 'anibridge',
      },
      {
        ref: { ns: 'tmdb_show', id: '111' },
        confidence: 90,
        sourceKey: 'anibridge',
      },
      {
        ref: { ns: 'simkl', id: '9' },
        confidence: 80,
        sourceKey: 'simkl-live',
      },
    ]);

    await retractPackFromGraph('anibridge');

    assert.equal(
      await getRepository(MappingLink).count({
        where: { sourceKey: 'anibridge' },
      }),
      0
    );
    const live = await getRepository(MappingLink).find({
      where: { sourceKey: 'simkl-live' },
    });
    assert.equal(live.length, 1);
    assert.equal(live[0].externalId, '9');
    assert.equal(await getRepository(MappingCluster).count(), 1);
  });

  it('skips live resolvers while a pack graph rewrite is in flight', async () => {
    const service = new MappingService();
    let liveCalls = 0;
    service.register({
      key: 'simkl',
      kind: 'live',
      trust: 80,
      supports: () => true,
      resolve: async () => {
        liveCalls += 1;
        return [
          {
            target: { ns: 'tmdb_show', id: '1' },
            confidence: 80,
            sourceKey: 'simkl-live',
          },
        ];
      },
    });

    beginPackGraphRewrite();
    try {
      const resolution = await service.resolve(
        { ns: 'anilist', id: '99' },
        'tmdb_show'
      );
      assert.equal(resolution.target, undefined);
      assert.equal(liveCalls, 0);
    } finally {
      endPackGraphRewrite();
    }
  });
});
