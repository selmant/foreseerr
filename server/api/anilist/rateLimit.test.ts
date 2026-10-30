import AnilistAPI, {
  AnilistRateLimitedError,
  resetAnilistRateLimitState,
} from '@server/api/anilist';
import cacheManager from '@server/lib/cache';
import type { AxiosInstance, AxiosResponse } from 'axios';
import { AxiosError } from 'axios';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

type Answer = {
  status: number;
  data: unknown;
  headers?: Record<string, string>;
};

/** A client whose requests get `answers` in turn; `calls()` counts them. */
const answering = (answers: Answer[]) => {
  const api = new AnilistAPI();
  let calls = 0;
  (api as unknown as { axios: AxiosInstance }).axios.defaults.adapter = async (
    config
  ) => {
    const answer = answers[calls] ?? { status: 500, data: {} };
    calls += 1;
    const response = {
      data: answer.data,
      status: answer.status,
      statusText: String(answer.status),
      headers: answer.headers ?? {},
      config,
    } as AxiosResponse;
    // Adapters settle themselves: a non-2xx answer rejects.
    if (answer.status >= 300) {
      throw new AxiosError(
        `Request failed with status code ${answer.status}`,
        AxiosError.ERR_BAD_REQUEST,
        config,
        null,
        response
      );
    }
    return response;
  };
  return { api, calls: () => calls };
};

const page = {
  data: { Page: { pageInfo: { hasNextPage: false }, media: [] } },
};
const limited = (retryAfter: string): Answer => ({
  status: 429,
  data: { errors: [{ message: 'Too Many Requests.', status: 429 }] },
  headers: { 'retry-after': retryAfter },
});

afterEach(() => {
  resetAnilistRateLimitState();
  cacheManager.getCache('anilist').flush();
});

describe('AnilistAPI rate limit', () => {
  it('waits out a short Retry-After and retries once', async () => {
    const { api, calls } = answering([
      limited('1'),
      { status: 200, data: page },
    ]);
    const started = Date.now();

    const result = await api.getTrending();

    assert.deepEqual(result.media, []);
    assert.equal(calls(), 2);
    assert.ok(Date.now() - started >= 900, 'waited for the Retry-After');
  });

  it('fails when the retry is rate limited too', async () => {
    const { api, calls } = answering([limited('1'), limited('1')]);

    await assert.rejects(
      () => api.getTrending(),
      (error: unknown) =>
        error instanceof AnilistRateLimitedError &&
        error.retryAfterSeconds === 1
    );
    assert.equal(calls(), 2);
  });

  it('holds every client back for a long Retry-After', async () => {
    const first = answering([limited('30')]);
    await assert.rejects(
      () => first.api.getTrending(),
      (error: unknown) =>
        error instanceof AnilistRateLimitedError &&
        error.retryAfterSeconds === 30
    );
    assert.equal(first.calls(), 1);

    const other = answering([{ status: 200, data: page }]);
    await assert.rejects(
      () => other.api.getPopular(),
      (error: unknown) =>
        error instanceof AnilistRateLimitedError &&
        error.retryAfterSeconds === 30
    );
    assert.equal(other.calls(), 0, 'never reached AniList');
  });

  it('answers from the cache while held back', async () => {
    const warm = answering([{ status: 200, data: page }]);
    await warm.api.getTrending();
    const blocked = answering([limited('30')]);
    await assert.rejects(() => blocked.api.getPopular());

    const cached = answering([]);
    const result = await cached.api.getTrending();

    assert.deepEqual(result.media, []);
    assert.equal(cached.calls(), 0);
  });
});
