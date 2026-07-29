import TraktAPI, { TRAKT_SYNC_PAGE_SIZE } from '@server/api/trakt';
import cacheManager from '@server/lib/cache';
import type { AxiosInstance, AxiosResponse } from 'axios';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

const makeApi = () =>
  new TraktAPI({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });

const rawClient = (api: TraktAPI): AxiosInstance =>
  (api as unknown as { rawAxios: AxiosInstance }).rawAxios;

const jsonResponse = <T>(
  config: AxiosResponse['config'],
  data: T
): AxiosResponse<T> =>
  ({
    data,
    status: 200,
    statusText: '200',
    headers: {},
    config,
  }) as AxiosResponse<T>;

afterEach(() => {
  cacheManager.getCache('trakt').flush();
});

describe('TraktAPI watched sync pagination', () => {
  it('requests episode progress on every watched-show page', async () => {
    const api = makeApi();
    const requests: { path?: string; params?: Record<string, unknown> }[] = [];
    rawClient(api).defaults.adapter = async (config) => {
      requests.push({ path: config.url, params: config.params });
      const page = Number(config.params?.page);
      const data =
        page === 1
          ? Array.from({ length: TRAKT_SYNC_PAGE_SIZE }, (_, index) => ({
              show: { ids: { tmdb: index + 1 } },
            }))
          : [
              {
                show: { ids: { tmdb: 233742 } },
                seasons: [{ number: 1, episodes: [{ number: 1, plays: 1 }] }],
              },
            ];
      return jsonResponse(config, data);
    };

    const watched = await api.getSyncWatched('tv');

    assert.equal(watched.length, TRAKT_SYNC_PAGE_SIZE + 1);
    assert.deepEqual(requests, [
      {
        path: '/sync/watched/shows',
        params: {
          extended: 'progress',
          page: 1,
          limit: TRAKT_SYNC_PAGE_SIZE,
        },
      },
      {
        path: '/sync/watched/shows',
        params: {
          extended: 'progress',
          page: 2,
          limit: TRAKT_SYNC_PAGE_SIZE,
        },
      },
    ]);
  });
});
