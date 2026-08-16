import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import type { AxiosInstance } from 'axios';

import SonarrAPI from '@server/api/servarr/sonarr';

function buildSonarr(): SonarrAPI {
  return new SonarrAPI({ url: 'http://localhost:8989/api/v3', apiKey: 'test' });
}

function getAxios(sonarr: SonarrAPI): AxiosInstance {
  return (sonarr as unknown as { axios: AxiosInstance }).axios;
}

describe('SonarrAPI removeSeries', () => {
  afterEach(() => mock.restoreAll());

  it('removes the series when it exists in the library', async () => {
    const sonarr = buildSonarr();
    mock.method(SonarrAPI.prototype, 'getSeriesByTvdbId', async () => ({
      id: 9,
      title: 'Test Series',
    }));
    const del = mock.method(getAxios(sonarr), 'delete', async () => ({}));

    await sonarr.removeSeries(1234);

    assert.strictEqual(del.mock.callCount(), 1);
    assert.strictEqual(del.mock.calls[0].arguments[0], '/series/9');
  });

  it('does nothing when the series is not in the library', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'get', async () => ({
      data: [{ id: 0, title: 'Breaking Bad' }],
    }));
    const del = mock.method(getAxios(sonarr), 'delete', async () => ({}));

    await assert.doesNotReject(() => sonarr.removeSeries(1234));
    assert.strictEqual(del.mock.callCount(), 0);
  });

  it('rejects when the tvdbId is unknown to the lookup', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'get', async () => ({ data: [] }));
    const del = mock.method(getAxios(sonarr), 'delete', async () => ({}));

    await assert.rejects(() => sonarr.removeSeries(1234), /Series not found/);
    assert.strictEqual(del.mock.callCount(), 0);
  });

  it('ignores a 404 when the series was already removed in Sonarr', async () => {
    const sonarr = buildSonarr();
    mock.method(SonarrAPI.prototype, 'getSeriesByTvdbId', async () => ({
      id: 9,
      title: 'Test Series',
    }));
    mock.method(getAxios(sonarr), 'delete', async () => {
      throw { response: { status: 404 } };
    });

    await assert.doesNotReject(() => sonarr.removeSeries(1234));
  });

  it('rethrows errors other than 404', async () => {
    const sonarr = buildSonarr();
    mock.method(SonarrAPI.prototype, 'getSeriesByTvdbId', async () => ({
      id: 9,
      title: 'Test Series',
    }));
    mock.method(getAxios(sonarr), 'delete', async () => {
      throw { response: { status: 500 } };
    });

    await assert.rejects(() => sonarr.removeSeries(1234));
  });

  it('rethrows a 404 from the lookup instead of treating it as removed', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'get', async () => {
      throw { response: { status: 404 } };
    });
    const del = mock.method(getAxios(sonarr), 'delete', async () => ({}));

    await assert.rejects(
      () => sonarr.removeSeries(1234),
      (e: unknown) =>
        (e as { response?: { status?: number } }).response?.status === 404
    );
    assert.strictEqual(del.mock.callCount(), 0);
  });
});

describe('SonarrAPI getSeriesByTvdbId', () => {
  afterEach(() => mock.restoreAll());

  it('rethrows a 401 from the lookup with the status intact', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'get', async () => {
      throw { response: { status: 401 } };
    });

    await assert.rejects(
      () => sonarr.getSeriesByTvdbId(1234),
      (e: unknown) =>
        (e as { response?: { status?: number } }).response?.status === 401
    );
  });

  it('throws "Series not found" when the lookup returns no results', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'get', async () => ({ data: [] }));

    await assert.rejects(() => sonarr.getSeriesByTvdbId(1234), {
      message: 'Series not found',
    });
  });
});

describe('SonarrAPI getCalendar', () => {
  afterEach(() => mock.restoreAll());

  it('requests the bounded calendar endpoint and preserves embedded series data', async () => {
    const sonarr = buildSonarr();
    const get = mock.method(getAxios(sonarr), 'get', async () => ({
      data: [
        {
          id: 7,
          seriesId: 4,
          title: 'Pilot',
          airDate: '2026-08-04',
          series: { id: 4, title: 'Example', tvdbId: 12, monitored: true },
        },
      ],
    }));
    const result = await sonarr.getCalendar('2026-08-01', '2026-08-31');

    assert.strictEqual(result[0].series?.tvdbId, 12);
    assert.strictEqual(get.mock.calls[0].arguments[0], '/calendar');
    assert.deepStrictEqual(get.mock.calls[0].arguments[1], {
      params: {
        start: '2026-08-01',
        end: '2026-08-31',
        unmonitored: false,
      },
    });
  });

  it('hydrates missing series metadata once per series', async () => {
    const sonarr = buildSonarr();
    const get = mock.method(getAxios(sonarr), 'get', async (path: string) => {
      if (path === '/calendar') {
        return {
          data: [
            {
              id: 7,
              seriesId: 4,
              title: 'Episode one',
              airDate: '2026-08-04',
            },
            {
              id: 8,
              seriesId: 4,
              title: 'Episode two',
              airDate: '2026-08-11',
            },
          ],
        };
      }

      assert.strictEqual(path, '/series/4');
      return {
        data: {
          id: 4,
          title: 'Example',
          tvdbId: 12,
          titleSlug: 'example',
          monitored: false,
        },
      };
    });

    const result = await sonarr.getCalendar('2026-08-01', '2026-08-31');

    assert.strictEqual(get.mock.callCount(), 2);
    assert.deepStrictEqual(
      result.map((episode) => episode.series),
      [
        {
          id: 4,
          title: 'Example',
          tvdbId: 12,
          titleSlug: 'example',
          monitored: false,
        },
        {
          id: 4,
          title: 'Example',
          tvdbId: 12,
          titleSlug: 'example',
          monitored: false,
        },
      ]
    );
  });
});

describe('SonarrAPI interactive management', () => {
  afterEach(() => mock.restoreAll());

  it('searches a specific episode and season pack', async () => {
    const sonarr = buildSonarr();
    const get = mock.method(getAxios(sonarr), 'get', async () => ({
      data: [],
    }));

    await sonarr.getEpisodeReleases(31);
    await sonarr.getSeasonReleases(9, 2);

    assert.deepStrictEqual(get.mock.calls[0].arguments, [
      '/release',
      { params: { episodeId: 31 } },
    ]);
    assert.deepStrictEqual(get.mock.calls[1].arguments, [
      '/release',
      { params: { seriesId: 9, seasonNumber: 2 } },
    ]);
  });

  it('submits an interactive release to Sonarr using its guid and indexer', async () => {
    const sonarr = buildSonarr();
    const post = mock.method(getAxios(sonarr), 'post', async () => ({
      data: {},
    }));

    await sonarr.grabRelease({
      guid: 'https://indexer.example/release/123',
      indexerId: 7,
      seriesId: 1,
    });

    assert.deepStrictEqual(post.mock.calls[0].arguments, [
      '/release',
      {
        guid: 'https://indexer.example/release/123',
        indexerId: 7,
        seriesId: 1,
      },
    ]);
  });

  it('forces a rejected Sonarr grab onto the searched series', async () => {
    const sonarr = buildSonarr();
    const post = mock.method(getAxios(sonarr), 'post', async () => ({
      data: {},
    }));

    await sonarr.grabRelease({
      guid: 'https://indexer.example/release/123',
      indexerId: 7,
      seriesId: 1,
      episodeIds: [9, 10],
      quality: { quality: { name: 'WEBDL-1080p' } },
      languages: [{ name: 'English' }],
      shouldOverride: true,
    });

    assert.deepStrictEqual(post.mock.calls[0].arguments, [
      '/release',
      {
        guid: 'https://indexer.example/release/123',
        indexerId: 7,
        seriesId: 1,
        episodeIds: [9, 10],
        shouldOverride: true,
        quality: { quality: { name: 'WEBDL-1080p' } },
        languages: [{ name: 'English' }],
      },
    ]);
  });

  it('filters queue activity to the selected series', async () => {
    const sonarr = buildSonarr();
    const get = mock.method(getAxios(sonarr), 'get', async () => ({
      data: {
        records: [
          { seriesId: 9, episodeId: 31, episode: { id: 31 } },
          { seriesId: 10, episodeId: 32, episode: { id: 32 } },
        ],
      },
    }));

    const queue = await sonarr.getSeriesQueue(9);

    assert.deepStrictEqual(get.mock.calls[0].arguments, [
      '/queue',
      { params: { includeEpisode: true } },
    ]);
    assert.deepStrictEqual(queue, [
      { seriesId: 9, episodeId: 31, episode: { id: 31 } },
    ]);
  });

  it('passes queue download context through to manual import discovery', async () => {
    const sonarr = buildSonarr();
    const get = mock.method(getAxios(sonarr), 'get', async () => ({
      data: [],
    }));

    await sonarr.getManualImportCandidates({
      seriesId: 9,
      folder: '/downloads/example',
      downloadId: 'download-id',
    });

    assert.deepStrictEqual(get.mock.calls[0].arguments, [
      '/manualimport',
      {
        params: {
          seriesId: 9,
          folder: '/downloads/example',
          downloadId: 'download-id',
          filterExistingFiles: true,
        },
      },
    ]);
  });

  it('asks Sonarr to reprocess an episode rematch before importing', async () => {
    const sonarr = buildSonarr();
    const post = mock.method(getAxios(sonarr), 'post', async () => ({
      data: [],
    }));
    const candidates = [
      {
        id: 4,
        path: '/downloads/example.mkv',
        name: 'example.mkv',
        size: 1,
        seriesId: 9,
        episodeIds: [31, 32],
      },
    ];

    await sonarr.reprocessManualImportCandidates(candidates);

    assert.deepStrictEqual(post.mock.calls[0].arguments, [
      '/manualimport',
      candidates,
    ]);
  });
});
