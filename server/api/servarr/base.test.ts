import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import type { AxiosInstance } from 'axios';

import {
  INTERACTIVE_RELEASE_SEARCH_TIMEOUT_MS,
  interactiveReleaseSearchTimeout,
} from '@server/api/servarr/base';
import SonarrAPI from '@server/api/servarr/sonarr';

function buildSonarr(): SonarrAPI {
  return new SonarrAPI({ url: 'http://localhost:8989/api/v3', apiKey: 'test' });
}

function getAxios(sonarr: SonarrAPI): AxiosInstance {
  return (sonarr as unknown as { axios: AxiosInstance }).axios;
}

describe('ServarrBase getQueue', () => {
  afterEach(() => mock.restoreAll());

  it('pages through the Arr queue until every record is loaded', async () => {
    const sonarr = buildSonarr();
    const get = mock.method(
      getAxios(sonarr),
      'get',
      async (_url: string, config?: { params?: { page?: number } }) => {
        const page = Number(config?.params?.page);
        if (page === 1) {
          return {
            data: {
              page: 1,
              pageSize: 250,
              totalRecords: 251,
              records: Array.from({ length: 250 }, (_, index) => ({
                id: index + 1,
              })),
            },
          };
        }
        return {
          data: {
            page: 2,
            pageSize: 250,
            totalRecords: 251,
            records: [{ id: 251 }],
          },
        };
      }
    );

    const queue = await sonarr.getQueue();

    assert.equal(get.mock.callCount(), 2);
    assert.deepEqual(get.mock.calls[0].arguments[1], {
      params: { page: 1, pageSize: 250, includeEpisode: true },
    });
    assert.equal(queue.length, 251);
    assert.equal(queue[250].id, 251);
  });
});

describe('interactiveReleaseSearchTimeout', () => {
  it('floors a leftover 10s global timeout to two minutes', () => {
    assert.equal(
      interactiveReleaseSearchTimeout(10_000),
      INTERACTIVE_RELEASE_SEARCH_TIMEOUT_MS
    );
  });

  it('keeps an administrator timeout longer than the search floor', () => {
    assert.equal(interactiveReleaseSearchTimeout(180_000), 180_000);
  });

  it('treats 0 as no timeout', () => {
    assert.equal(interactiveReleaseSearchTimeout(0), 0);
  });
});
