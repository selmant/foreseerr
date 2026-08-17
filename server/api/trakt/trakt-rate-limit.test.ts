import TraktAPI, {
  TraktRateLimitedError,
  resetTraktRateLimitState,
} from '@server/api/trakt';
import cacheManager from '@server/lib/cache';
import type { AxiosInstance, AxiosResponse } from 'axios';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

const makeApi = (accessToken = 'user-token-aaaaaaaa') =>
  new TraktAPI({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    accessToken,
    refreshToken: 'refresh-token',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });

const rawClient = (api: TraktAPI): AxiosInstance =>
  (api as unknown as { rawAxios: AxiosInstance }).rawAxios;

const jsonResponse = <T>(
  config: AxiosResponse['config'],
  status: number,
  data: T,
  headers: Record<string, string> = {}
): AxiosResponse<T> =>
  ({
    data,
    status,
    statusText: String(status),
    headers,
    config,
  }) as AxiosResponse<T>;

afterEach(() => {
  resetTraktRateLimitState();
  cacheManager.getCache('trakt').flush();
});

describe('TraktAPI rate limit gating', () => {
  it('opens a per-client circuit on 429 without blocking other tokens', async () => {
    const api = makeApi();
    const client = rawClient(api);
    let calls = 0;
    client.defaults.adapter = async (config) => {
      calls += 1;
      return jsonResponse(config, 429, {}, { 'retry-after': '120' });
    };

    await assert.rejects(
      () =>
        (
          api as unknown as {
            getAuthenticated: (path: string) => Promise<unknown>;
          }
        ).getAuthenticated('/users/me/lists/test'),
      (error: unknown) => {
        assert.ok(error instanceof TraktRateLimitedError);
        assert.equal(error.retryAfterSeconds, 120);
        return true;
      }
    );

    const second = makeApi('user-token-bbbbbbbb');
    let secondCalls = 0;
    rawClient(second).defaults.adapter = async (config) => {
      secondCalls += 1;
      return jsonResponse(config, 200, [{ type: 'show' }]);
    };

    const otherUser = await (
      second as unknown as {
        getAuthenticated: (path: string) => Promise<unknown>;
      }
    ).getAuthenticated('/users/me/lists/other');
    assert.deepEqual(otherUser, [{ type: 'show' }]);
    assert.equal(calls, 1);
    assert.equal(secondCalls, 1);

    await assert.rejects(
      () =>
        (
          api as unknown as {
            getAuthenticated: (path: string) => Promise<unknown>;
          }
        ).getAuthenticated('/users/me/lists/retry'),
      TraktRateLimitedError
    );
    assert.equal(calls, 1);
  });

  it('caches authenticated GETs so repeats skip the network', async () => {
    const api = makeApi();
    const client = rawClient(api);
    let calls = 0;
    client.defaults.adapter = async (config) => {
      calls += 1;
      return jsonResponse(config, 200, [{ type: 'movie' }]);
    };

    const getAuthenticated = (
      api as unknown as {
        getAuthenticated: (path: string) => Promise<unknown>;
      }
    ).getAuthenticated.bind(api);

    const first = await getAuthenticated('/users/me/lists/test/items/movies');
    const second = await getAuthenticated('/users/me/lists/test/items/movies');

    assert.deepEqual(first, [{ type: 'movie' }]);
    assert.deepEqual(second, [{ type: 'movie' }]);
    assert.equal(calls, 1);
  });

  it('does not fall back to public requests after a rate limit', async () => {
    const api = makeApi();
    const client = rawClient(api);
    let authCalls = 0;
    client.defaults.adapter = async (config) => {
      authCalls += 1;
      return jsonResponse(config, 429, {}, { 'retry-after': '90' });
    };

    const axiosClient = (api as unknown as { axios: AxiosInstance }).axios;
    let publicCalls = 0;
    axiosClient.defaults.adapter = async () => {
      publicCalls += 1;
      throw new Error('public fallback should not run on 429');
    };

    await assert.rejects(
      () =>
        (
          api as unknown as {
            getAuthenticatedOrPublic: (path: string) => Promise<unknown>;
          }
        ).getAuthenticatedOrPublic('/users/alice/lists/favorites'),
      TraktRateLimitedError
    );
    assert.equal(authCalls, 1);
    assert.equal(publicCalls, 0);
  });

  it('flushes watched GET cache after episode history writes', async () => {
    const api = makeApi();
    const client = rawClient(api);
    const calls: string[] = [];
    client.defaults.adapter = async (config) => {
      calls.push(`${String(config.method).toLowerCase()}:${config.url}`);
      if (String(config.method).toLowerCase() === 'post') {
        return jsonResponse(config, 200, { added: { episodes: 1 } });
      }
      return jsonResponse(config, 200, [{ show: { ids: { tmdb: 1399 } } }]);
    };

    await api.getSyncWatched('tv');
    await api.getSyncWatched('tv');
    assert.equal(calls.filter((call) => call.startsWith('get:')).length, 1);

    await api.addEpisodeToHistory(1399, 1, 1);

    await api.getSyncWatched('tv');
    assert.equal(calls.filter((call) => call.startsWith('get:')).length, 2);
  });
});
