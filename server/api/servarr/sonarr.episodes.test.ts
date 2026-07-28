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
});
