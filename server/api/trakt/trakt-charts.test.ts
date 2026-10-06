import TraktAPI, { resetTraktRateLimitState } from '@server/api/trakt';
import cacheManager from '@server/lib/cache';
import type { AxiosInstance, AxiosResponse } from 'axios';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

const media = (title: string, tmdb: number) => ({
  title,
  year: 2026,
  ids: { trakt: tmdb, slug: title.toLowerCase(), tmdb },
});

// Popular answers with bare media objects; trending and anticipated wrap them.
const charts: Record<string, unknown[]> = {
  '/movies/popular': [media('Movie A', 1), media('Movie B', 2)],
  '/shows/popular': [media('Show A', 11), media('Show B', 12)],
  '/movies/trending': [{ watchers: 9, movie: media('Movie C', 3) }],
  '/shows/anticipated': [{ list_count: 40, show: media('Show C', 13) }],
};

const makeApi = () => {
  const api = new TraktAPI({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    accessToken: 'user-token-charts',
    refreshToken: 'refresh-token',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  (api as unknown as { rawAxios: AxiosInstance }).rawAxios.defaults.adapter =
    async (config) =>
      ({
        data: (config.params?.page ?? 1) === 1 ? charts[config.url ?? ''] : [],
        status: 200,
        statusText: '200',
        headers: {},
        config,
      }) as AxiosResponse;
  return api;
};

afterEach(() => {
  resetTraktRateLimitState();
  cacheManager.getCache('trakt').flush();
});

describe('TraktAPI.getChartItems', () => {
  it('reads wrapped chart entries for a single media type', async () => {
    const trending = await makeApi().getChartItems('trending', 'movie');
    assert.deepEqual(
      trending.items.map((item) => [item.mediaType, item.tmdbId]),
      [['movie', 3]]
    );

    const anticipated = await makeApi().getChartItems('anticipated', 'tv');
    assert.deepEqual(
      anticipated.items.map((item) => [item.mediaType, item.tmdbId]),
      [['tv', 13]]
    );
  });

  it('interleaves movies and shows by chart position', async () => {
    const popular = await makeApi().getChartItems('popular', 'all', {
      limit: 4,
    });
    assert.deepEqual(
      popular.items.map((item) => item.title),
      ['Movie A', 'Show A', 'Movie B', 'Show B']
    );
  });
});
