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
  it('opens a shared circuit on 429 and blocks later requests', async () => {
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
    rawClient(second).defaults.adapter = async () => {
      throw new Error('should not hit network while circuit open');
    };

    await assert.rejects(
      () =>
        (
          second as unknown as {
            getAuthenticated: (path: string) => Promise<unknown>;
          }
        ).getAuthenticated('/users/me/lists/other'),
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
});
