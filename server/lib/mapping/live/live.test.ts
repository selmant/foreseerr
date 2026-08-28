import type SimklAPI from '@server/api/simkl';
import {
  budgetSnapshot,
  clearNegativeCache,
  isNegativelyCached,
  resetBudgets,
} from '@server/lib/mapping/budget';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { anizipResolver } from './anizip';
import { simklResolver } from './simkl';
import { tvdbResolver } from './tvdb';

setupTestDb();

beforeEach(() => {
  resetBudgets();
  clearNegativeCache();
});

interface FakeSimklOptions {
  redirect?: Awaited<ReturnType<SimklAPI['redirectToSimklId']>>;
  detail?: Record<string, unknown>;
  redirectStatus?: number;
  detailStatus?: number;
  sentinelHealthy?: boolean;
}

const httpError = (status: number): Error =>
  Object.assign(new Error(`HTTP ${status}`), {
    isAxiosError: true,
    response: { status },
  });

const fakeSimkl = (options: FakeSimklOptions) => {
  const calls: string[] = [];
  const client = {
    redirectToSimklId: async () => {
      calls.push('redirect');
      if (options.redirectStatus) throw httpError(options.redirectStatus);
      return options.redirect;
    },
    getTitle: async () => {
      calls.push('detail');
      if (options.detailStatus) throw httpError(options.detailStatus);
      return options.detail ?? {};
    },
    sentinelIsHealthy: async () => {
      calls.push('sentinel');
      return options.sentinelHealthy ?? true;
    },
  } as unknown as SimklAPI;
  return { client, calls };
};

describe('simkl live resolver', () => {
  it('bridges anilist to imdb through the redirect and detail pair', async () => {
    const { client, calls } = fakeSimkl({
      redirect: { simklId: '1234', kind: 'anime' },
      detail: { ids: { imdb: 'tt0987654', tmdb: 999 } },
    });
    const resolver = simklResolver(() => client);

    const candidates = await resolver.resolve(
      { ns: 'anilist', id: '110277' },
      'imdb'
    );

    assert.deepEqual(calls, ['redirect', 'detail']);
    assert.equal(candidates.length, 1);
    assert.deepEqual(candidates[0].target, { ns: 'imdb', id: 'tt0987654' });
    assert.ok(candidates[0].confidence >= 80);
  });

  it('offers a Simkl anime tmdb id only at low confidence', async () => {
    const { client } = fakeSimkl({
      redirect: { simklId: '1234', kind: 'anime' },
      detail: { ids: { tmdb: 1429 } },
    });
    const resolver = simklResolver(() => client);

    const [candidate] = await resolver.resolve(
      { ns: 'anilist', id: '110277' },
      'tmdb_show'
    );

    assert.deepEqual(candidate.target, { ns: 'tmdb_show', id: '1429' });
    // Below any acceptance threshold: it must be corroborated, never trusted.
    assert.ok(
      candidate.confidence < 50,
      `expected low confidence, got ${candidate.confidence}`
    );
  });

  it('trusts a non-anime tmdb id more than an anime one', async () => {
    const { client } = fakeSimkl({
      redirect: { simklId: '77', kind: 'tv' },
      detail: { ids: { tmdb: 1396 } },
    });
    const resolver = simklResolver(() => client);

    const [candidate] = await resolver.resolve(
      { ns: 'imdb', id: 'tt0903747' },
      'tmdb_show'
    );

    assert.ok(candidate.confidence >= 70);
  });

  it('never returns a movie id for a Simkl tv record', async () => {
    const { client } = fakeSimkl({
      redirect: { simklId: '77', kind: 'tv' },
      detail: { ids: { tmdb: 1396 } },
    });
    const resolver = simklResolver(() => client);

    const candidates = await resolver.resolve(
      { ns: 'imdb', id: 'tt0903747' },
      'tmdb_movie'
    );

    assert.deepEqual(candidates, []);
  });

  it('reads 412 as not-found when the sentinel probe succeeds', async () => {
    const { client, calls } = fakeSimkl({
      detailStatus: 412,
      redirect: { simklId: '4242', kind: 'anime' },
      sentinelHealthy: true,
    });
    const resolver = simklResolver(() => client);

    const candidates = await resolver.resolve(
      { ns: 'anilist', id: '999999' },
      'imdb'
    );

    assert.deepEqual(candidates, []);
    assert.ok(calls.includes('sentinel'));
    assert.equal(isNegativelyCached('simkl-detail', 'anime/4242'), true);
    const detail = budgetSnapshot().find(
      (entry) => entry.key === 'simkl-detail'
    );
    assert.equal(detail?.circuitState, 'closed');
  });

  it('reads 412 as blocked and opens the breaker when the sentinel also fails', async () => {
    const { client } = fakeSimkl({
      detailStatus: 412,
      redirect: { simklId: '4242', kind: 'anime' },
      sentinelHealthy: false,
    });
    const resolver = simklResolver(() => client);

    await resolver.resolve({ ns: 'anilist', id: '110277' }, 'imdb');

    const snapshot = budgetSnapshot();
    for (const key of ['simkl-detail', 'simkl-redirect']) {
      const entry = snapshot.find((row) => row.key === key);
      assert.equal(entry?.circuitState, 'open', `${key} should be open`);
    }
  });

  it('negative-caches a redirect miss so the slider stops asking', async () => {
    const { client, calls } = fakeSimkl({ redirect: undefined });
    const resolver = simklResolver(() => client);

    await resolver.resolve({ ns: 'anilist', id: '5' }, 'imdb');
    await resolver.resolve({ ns: 'anilist', id: '5' }, 'imdb');

    assert.deepEqual(calls, ['redirect']);
  });
});

describe('tvdb remoteid resolver', () => {
  it('scopes matches to the requested tvdb namespace', async () => {
    const client = {
      searchRemoteId: async () => [
        { tvdbId: 1, type: 'movie' as const },
        { tvdbId: 2, type: 'series' as const },
      ],
    };
    const resolver = tvdbResolver(
      async () =>
        client as unknown as Awaited<ReturnType<typeof tvdbResolver>> & never
    );

    const shows = await resolver.resolve(
      { ns: 'imdb', id: 'tt1' },
      'tvdb_show'
    );
    const movies = await resolver.resolve(
      { ns: 'imdb', id: 'tt1' },
      'tvdb_movie'
    );

    assert.deepEqual(
      shows.map((candidate) => candidate.target.id),
      ['2']
    );
    assert.deepEqual(
      movies.map((candidate) => candidate.target.id),
      ['1']
    );
  });
});

describe('resolver support matrix', () => {
  it('never asks TMDB /find for a movie by tvdb id', async () => {
    const { tmdbFindResolver } = await import('./tmdbFind');
    const resolver = tmdbFindResolver();

    assert.equal(
      resolver.supports({ ns: 'tvdb_show', id: '1' }, 'tmdb_movie'),
      false
    );
    assert.equal(
      resolver.supports({ ns: 'tvdb_show', id: '1' }, 'tmdb_show'),
      true
    );
    assert.equal(
      resolver.supports({ ns: 'imdb', id: 'tt1' }, 'tmdb_movie'),
      true
    );
  });

  it('only accepts namespaces ani.zip can query', () => {
    const resolver = anizipResolver();

    assert.equal(
      resolver.supports({ ns: 'anilist', id: '1' }, 'tvdb_show'),
      true
    );
    assert.equal(
      resolver.supports({ ns: 'trakt', id: 'x' }, 'tvdb_show'),
      false
    );
  });
});
