import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import type { AxiosInstance } from 'axios';

import RadarrAPI from '@server/api/servarr/radarr';

function buildRadarr(): RadarrAPI {
  return new RadarrAPI({ url: 'http://localhost:7878/api/v3', apiKey: 'test' });
}

function getAxios(radarr: RadarrAPI): AxiosInstance {
  return (radarr as unknown as { axios: AxiosInstance }).axios;
}

describe('RadarrAPI removeMovie', () => {
  afterEach(() => mock.restoreAll());

  it('removes the movie when it exists in the library', async () => {
    const radarr = buildRadarr();
    mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => ({
      id: 7,
      title: 'Test Movie',
    }));
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await radarr.removeMovie(550);

    assert.strictEqual(del.mock.callCount(), 1);
    assert.strictEqual(del.mock.calls[0].arguments[0], '/movie/7');
  });

  it('does nothing when the movie is not in the library', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => ({
      data: [{ id: 0, title: 'Fight Club' }],
    }));
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await assert.doesNotReject(() => radarr.removeMovie(550));
    assert.strictEqual(del.mock.callCount(), 0);
  });

  it('rejects when the tmdbId is unknown to the lookup', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => ({ data: [] }));
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await assert.rejects(() => radarr.removeMovie(550), /Movie not found/);
    assert.strictEqual(del.mock.callCount(), 0);
  });

  it('ignores a 404 when the movie was already removed in Radarr', async () => {
    const radarr = buildRadarr();
    mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => ({
      id: 7,
      title: 'Test Movie',
    }));
    mock.method(getAxios(radarr), 'delete', async () => {
      throw { response: { status: 404 } };
    });

    await assert.doesNotReject(() => radarr.removeMovie(550));
  });

  it('rethrows errors other than 404', async () => {
    const radarr = buildRadarr();
    mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => ({
      id: 7,
      title: 'Test Movie',
    }));
    mock.method(getAxios(radarr), 'delete', async () => {
      throw { response: { status: 500 } };
    });

    await assert.rejects(() => radarr.removeMovie(550));
  });

  it('rethrows a 404 from the lookup instead of treating it as removed', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => {
      throw { response: { status: 404 } };
    });
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await assert.rejects(
      () => radarr.removeMovie(550),
      (e: unknown) =>
        (e as { response?: { status?: number } }).response?.status === 404
    );
    assert.strictEqual(del.mock.callCount(), 0);
  });
});

describe('RadarrAPI getMovieByTmdbId', () => {
  afterEach(() => mock.restoreAll());

  it('rethrows a 401 from the lookup with the status intact', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => {
      throw { response: { status: 401 } };
    });

    await assert.rejects(
      () => radarr.getMovieByTmdbId(550),
      (e: unknown) =>
        (e as { response?: { status?: number } }).response?.status === 401
    );
  });

  it('throws "Movie not found" when the lookup returns no results', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => ({ data: [] }));

    await assert.rejects(() => radarr.getMovieByTmdbId(550), {
      message: 'Movie not found',
    });
  });
});

describe('RadarrAPI getCalendar', () => {
  afterEach(() => mock.restoreAll());

  it('requests the bounded calendar endpoint with unmonitored entries opt-in', async () => {
    const radarr = buildRadarr();
    const get = mock.method(getAxios(radarr), 'get', async () => ({
      data: [{ id: 12, title: 'Example', digitalRelease: '2026-08-04' }],
    }));
    const start = new Date('2026-08-01T00:00:00.000Z');
    const end = new Date('2026-08-31T00:00:00.000Z');

    const result = await radarr.getCalendar(start, end, true);

    assert.strictEqual(result[0].digitalRelease, '2026-08-04');
    assert.strictEqual(get.mock.calls[0].arguments[0], '/calendar');
    assert.deepStrictEqual(get.mock.calls[0].arguments[1], {
      params: {
        start: start.toISOString(),
        end: end.toISOString(),
        unmonitored: true,
      },
    });
  });
});

describe('RadarrAPI interactive management', () => {
  afterEach(() => mock.restoreAll());

  it('searches releases for one movie and grabs the selected release', async () => {
    const radarr = buildRadarr();
    const get = mock.method(getAxios(radarr), 'get', async () => ({
      data: [{ guid: 'release-guid', indexerId: 4, title: 'Example' }],
    }));
    const post = mock.method(getAxios(radarr), 'post', async () => ({
      data: {},
    }));

    const releases = await radarr.getMovieReleases(55);
    await radarr.grabRelease(releases[0]);

    assert.deepStrictEqual(get.mock.calls[0].arguments, [
      '/release',
      { params: { movieId: 55 } },
    ]);
    assert.deepStrictEqual(post.mock.calls[0].arguments, [
      '/release',
      { guid: 'release-guid', indexerId: 4 },
    ]);
  });

  it('uses the mapped movie when retrieving manual import candidates', async () => {
    const radarr = buildRadarr();
    const get = mock.method(getAxios(radarr), 'get', async () => ({
      data: [],
    }));

    await radarr.getManualImportCandidates({ movieId: 12 });

    assert.deepStrictEqual(get.mock.calls[0].arguments, [
      '/manualimport',
      { params: { movieId: 12, filterExistingFiles: true } },
    ]);
  });
});
