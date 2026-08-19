import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import SonarrAPI, { type EpisodeResult } from './sonarr';

const episode = (overrides: Partial<EpisodeResult>): EpisodeResult => ({
  id: 1,
  tvdbId: 101,
  seriesId: 9,
  episodeFileId: 0,
  seasonNumber: 1,
  episodeNumber: 1,
  title: 'Pilot',
  airDate: '2020-01-01',
  airDateUtc: '2020-01-01T00:00:00Z',
  overview: '',
  hasFile: false,
  monitored: false,
  absoluteEpisodeNumber: 1,
  unverifiedSceneNumbering: false,
  ...overrides,
});

describe('Sonarr exact episode selection', () => {
  it('monitors and searches only requested aired missing episodes', async () => {
    const api = new SonarrAPI({ apiKey: 'test', url: 'http://127.0.0.1' });
    mock.method(api, 'getEpisodes', async () => [
      episode({ id: 1, tvdbId: 101 }),
      episode({ id: 2, tvdbId: 102, monitored: true, hasFile: true }),
      episode({
        id: 3,
        tvdbId: 103,
        airDateUtc: '2999-01-01T00:00:00Z',
      }),
      episode({ id: 4, tvdbId: 999 }),
    ]);
    const monitor = mock.method(api, 'monitorEpisodes', async () => undefined);
    const search = mock.method(api, 'searchEpisodes', async () => undefined);

    await api.applyEpisodeSelection(9, [101, 102, 103], true);

    assert.deepEqual(monitor.mock.calls[0].arguments[0], [1, 3]);
    assert.deepEqual(search.mock.calls[0].arguments[0], [1]);
  });

  it('fails rather than broadening an unresolved TVDB selection', async () => {
    const api = new SonarrAPI({ apiKey: 'test', url: 'http://127.0.0.1' });
    mock.method(api, 'getEpisodes', async () => [episode({ tvdbId: 101 })]);
    await assert.rejects(api.applyEpisodeSelection(9, [101, 404], true), /404/);
  });

  it('waits for a newly added series to populate its episode catalog', async () => {
    const api = new SonarrAPI({ apiKey: 'test', url: 'http://127.0.0.1' });
    let lookupCount = 0;
    const getEpisodes = mock.method(api, 'getEpisodes', async () => {
      lookupCount += 1;
      return lookupCount < 3
        ? []
        : [episode({ id: 1, tvdbId: 101 }), episode({ id: 2, tvdbId: 102 })];
    });
    const monitor = mock.method(api, 'monitorEpisodes', async () => undefined);
    const search = mock.method(api, 'searchEpisodes', async () => undefined);

    await api.applyEpisodeSelection(9, [101, 102], true, {
      attempts: 3,
      delayMs: 0,
    });

    assert.equal(getEpisodes.mock.callCount(), 3);
    assert.deepEqual(monitor.mock.calls[0].arguments[0], [1, 2]);
    assert.deepEqual(search.mock.calls[0].arguments[0], [1, 2]);
  });

  it('still fails after bounded episode catalog polling is exhausted', async () => {
    const api = new SonarrAPI({ apiKey: 'test', url: 'http://127.0.0.1' });
    const getEpisodes = mock.method(api, 'getEpisodes', async () => []);

    await assert.rejects(
      api.applyEpisodeSelection(9, [101], false, {
        attempts: 3,
        delayMs: 0,
      }),
      /101/
    );
    assert.equal(getEpisodes.mock.callCount(), 3);
  });

  it('waits for Sonarr addOptions to finish before monitoring a new series', async () => {
    const api = new SonarrAPI({ apiKey: 'test', url: 'http://127.0.0.1' });
    let seriesLookups = 0;
    const getSeriesById = mock.method(api, 'getSeriesById', async () => {
      seriesLookups += 1;
      return seriesLookups < 2
        ? { addOptions: { ignoreEpisodesWithFiles: true, monitor: 'none' } }
        : {};
    });
    mock.method(api, 'getEpisodes', async () => [
      episode({ id: 1, tvdbId: 101 }),
      episode({ id: 2, tvdbId: 102 }),
    ]);
    const monitor = mock.method(api, 'monitorEpisodes', async () => undefined);
    mock.method(api, 'searchEpisodes', async () => undefined);

    await api.applyEpisodeSelection(9, [101, 102], true, {
      attempts: 3,
      delayMs: 0,
      waitForAddOptions: true,
    });

    assert.equal(getSeriesById.mock.callCount(), 2);
    assert.deepEqual(monitor.mock.calls[0].arguments[0], [1, 2]);
  });
});
