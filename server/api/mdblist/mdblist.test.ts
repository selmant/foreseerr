import type { AxiosInstance, AxiosResponse } from 'axios';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import MdblistAPI, {
  getMdblistMetrics,
  parseMdblistRatings,
  resetMdblistMetrics,
} from './index';
import type { MdblistMediaPayload } from './types';

/**
 * Real-shaped MDBList payload for Game of Thrones (a series OMDb returns
 * almost no RT/Metacritic data for). `score` is normalised 0–100 for every
 * source regardless of the per-source `value` scale.
 */
const GOT_PAYLOAD: MdblistMediaPayload = {
  title: 'Game of Thrones',
  type: 'show',
  ids: { imdb: 'tt0944947', trakt: 1390, tmdb: 1399, tvdb: 121361 },
  ratings: [
    { source: 'imdb', value: 9.2, score: 92, votes: 2630633 },
    { source: 'metacritic', value: 86, score: 86, votes: 171 },
    { source: 'metacriticuser', value: 8.4, score: 84.0, votes: 20104 },
    { source: 'trakt', value: 88, score: 88, votes: 64214 },
    { source: 'tomatoes', value: 89, score: 89, votes: 337 },
    { source: 'popcorn', value: 85, score: 85, votes: null },
    { source: 'tmdb', value: 84, score: 84, votes: 27165 },
    { source: 'letterboxd', value: null, score: null, votes: null },
  ],
};

describe('parseMdblistRatings', () => {
  it('maps scores to normalized columns', () => {
    const parsed = parseMdblistRatings(GOT_PAYLOAD);
    assert.equal(parsed.imdbId, 'tt0944947');
    assert.equal(parsed.imdbRating, 9.2);
    assert.equal(parsed.imdbVotes, 2630633);
    assert.equal(parsed.rtRating, 89);
    assert.equal(parsed.rtUserRating, 85);
    assert.equal(parsed.metacriticRating, 86);
    assert.equal(parsed.traktRating, 8.8);
    assert.equal(parsed.traktVotes, 64214);
    assert.equal(parsed.tmdbRating, 8.4);
  });

  it('missing sources become undefined', () => {
    const parsed = parseMdblistRatings({ ids: {}, ratings: [] });
    assert.equal(parsed.imdbRating, undefined);
    assert.equal(parsed.rtRating, undefined);
    assert.equal(parsed.rtUserRating, undefined);
    assert.equal(parsed.metacriticRating, undefined);
    assert.equal(parsed.traktRating, undefined);
    assert.equal(parsed.tmdbRating, undefined);
  });
});

describe('MdblistAPI batch ratings', () => {
  it('uses one batch call and fills the per-title cache', async () => {
    const api = new MdblistAPI('test-api-key');
    let batchCalls = 0;
    const firstId = 9_900_001;
    const secondId = 9_900_002;
    const payload = (tmdbId: number, score: number): MdblistMediaPayload => ({
      ids: { tmdb: tmdbId },
      ratings: [{ source: 'imdb', score }],
    });

    (
      api as unknown as {
        post: () => Promise<MdblistMediaPayload[]>;
      }
    ).post = async () => {
      batchCalls += 1;
      return [payload(secondId, 72), payload(firstId, 81)];
    };

    const ratings = await api.getBatchRatings('movie', [
      { tmdbId: firstId, cacheTtlSeconds: 60 },
      { tmdbId: secondId, cacheTtlSeconds: 60 },
    ]);

    assert.equal(batchCalls, 1);
    assert.equal(ratings.get(firstId)?.imdbRating, 8.1);
    assert.equal(ratings.get(secondId)?.imdbRating, 7.2);

    const cached = await api.getRatings('movie', firstId, 60);
    assert.equal(cached?.imdbRating, 8.1);
    assert.equal(batchCalls, 1);
  });

  it('honors quota headers and blocks later batches until reset', async () => {
    resetMdblistMetrics();
    const api = new MdblistAPI('test-api-key');
    let batchCalls = 0;
    (
      api as unknown as {
        post: () => Promise<MdblistMediaPayload[]>;
      }
    ).post = async () => {
      batchCalls += 1;
      throw Object.assign(new Error('quota exceeded'), {
        response: {
          status: 429,
          headers: { 'retry-after': '120' },
        },
      });
    };

    const first = await api.getBatchRatings('movie', [{ tmdbId: 9_900_003 }]);
    const blocked = await api.getBatchRatings('movie', [{ tmdbId: 9_900_004 }]);

    assert.equal(first.get(9_900_003), null);
    assert.equal(blocked.get(9_900_004), null);
    assert.equal(batchCalls, 1);
    assert.equal(getMdblistMetrics().rateLimits, 1);
    assert.equal(
      (api as unknown as { circuitOpenTimeoutMs: number }).circuitOpenTimeoutMs,
      120_000
    );
  });

  it('stops after a successful response reports no quota remaining', async () => {
    const api = new MdblistAPI('test-api-key');
    const client = (api as unknown as { axios: AxiosInstance }).axios;
    let batchCalls = 0;
    client.defaults.adapter = async (config) => {
      batchCalls += 1;
      return {
        data: [{ ids: { tmdb: 9_900_005 }, ratings: [] }],
        status: 200,
        statusText: 'OK',
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 120),
        },
        config,
      } as AxiosResponse<MdblistMediaPayload[]>;
    };

    await api.getBatchRatings('movie', [{ tmdbId: 9_900_005 }]);
    const blocked = await api.getBatchRatings('movie', [{ tmdbId: 9_900_006 }]);

    assert.equal(blocked.get(9_900_006), null);
    assert.equal(batchCalls, 1);
  });
});

describe('MdblistAPI public lists', () => {
  it('searches lists and caches the query', async () => {
    const api = new MdblistAPI('test-api-key');
    const client = (api as unknown as { axios: AxiosInstance }).axios;
    let searchCalls = 0;

    client.defaults.adapter = async (config) => {
      searchCalls += 1;
      assert.match(String(config.url), /\/lists\/search$/);
      assert.equal(config.params?.query, 'horror');
      return {
        data: [
          {
            id: 9_800_001,
            name: 'Horror',
            slug: 'horror',
            user_name: 'hdlists',
            mediatype: 'movie',
            items: 12,
            likes: 4,
          },
        ],
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      } as AxiosResponse;
    };

    const first = await api.searchLists('horror');
    const second = await api.searchLists('horror');

    assert.equal(searchCalls, 1);
    assert.equal(first.length, 1);
    assert.equal(first[0].name, 'Horror');
    assert.equal(first[0].username, 'hdlists');
    assert.deepEqual(second, first);
  });

  it('fetches list items with offset/limit in the cache key', async () => {
    const api = new MdblistAPI('test-api-key');
    const client = (api as unknown as { axios: AxiosInstance }).axios;
    const itemCalls: { limit?: number; offset?: number }[] = [];

    client.defaults.adapter = async (config) => {
      const url = String(config.url);
      if (url.endsWith('/items')) {
        itemCalls.push({
          limit: Number(config.params?.limit),
          offset: Number(config.params?.offset),
        });
        const offset = Number(config.params?.offset) || 0;
        return {
          data: {
            movies: [
              {
                id: 9_800_100 + offset,
                rank: offset + 1,
                title: `Title ${offset}`,
                mediatype: 'movie',
                ids: { tmdb: 9_800_100 + offset },
              },
            ],
            shows: [],
          },
          status: 200,
          statusText: 'OK',
          headers: {},
          config,
        } as AxiosResponse;
      }

      return {
        data: [
          {
            id: 9_800_010,
            name: 'Custom List',
            slug: 'custom-list',
            user_name: 'tester',
          },
        ],
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      } as AxiosResponse;
    };

    const pageOne = await api.getListItems('9800010', {
      limit: 20,
      offset: 0,
    });
    const pageOneCached = await api.getListItems('9800010', {
      limit: 20,
      offset: 0,
    });
    const pageTwo = await api.getListItems('9800010', {
      limit: 20,
      offset: 20,
    });

    assert.deepEqual(itemCalls, [
      { limit: 20, offset: 0 },
      { limit: 20, offset: 20 },
    ]);
    assert.equal(pageOne.title, 'Custom List');
    assert.equal(pageOne.items[0]?.tmdbId, 9_800_100);
    assert.equal(pageOneCached.items[0]?.tmdbId, 9_800_100);
    assert.equal(pageTwo.items[0]?.tmdbId, 9_800_120);
    assert.equal(pageOne.hasMore, false);
  });
});
