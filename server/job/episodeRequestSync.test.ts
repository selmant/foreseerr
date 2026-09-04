import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock, type TestContext } from 'node:test';

import SonarrAPI, {
  type EpisodeResult,
  type SonarrSeries,
} from '@server/api/servarr/sonarr';
import Tvdb from '@server/api/tvdb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import EpisodeRequest from '@server/entity/EpisodeRequest';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import * as watchAhead from '@server/lib/watchAhead';
import { setupTestDb } from '@server/test/db';
import episodeRequestSync from './episodeRequestSync';

setupTestDb();

beforeEach(() => {
  getSettings().sonarr = [];
  mock.method(MediaRequest, 'sendNotification', async () => undefined);
});

const sonarrEpisode = (
  id: number,
  tvdbId: number,
  episodeNumber: number,
  hasFile: boolean
): EpisodeResult => ({
  id,
  tvdbId,
  seriesId: 55,
  episodeFileId: hasFile ? id : 0,
  seasonNumber: 1,
  episodeNumber,
  title: `Episode ${episodeNumber}`,
  airDate: '2020-01-01',
  airDateUtc: '2020-01-01T00:00:00Z',
  overview: '',
  hasFile,
  monitored: hasFile,
  absoluteEpisodeNumber: episodeNumber,
  unverifiedSceneNumbering: false,
});

describe('episode request synchronization', () => {
  it('expands an ongoing rule without increasing quota and completes it only when ended', async (t: TestContext) => {
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 9001,
        tvdbId: 8001,
        mediaType: MediaType.TV,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.UNKNOWN,
        serviceId: 0,
        externalServiceId: 55,
      })
    );
    const created = await getRepository(MediaRequest).save(
      new MediaRequest({
        media,
        requestedBy: user,
        type: MediaType.TV,
        status: MediaRequestStatus.APPROVED,
        is4k: false,
        seasons: [],
        episodeSelectionType: 'after',
        episodeStartTvdbId: 101,
        tvQuotaUnits: 1,
        episodes: [
          new EpisodeRequest({
            tvdbId: 101,
            seasonNumber: 1,
            episodeNumber: 1,
            status: MediaRequestStatus.APPROVED,
          }),
        ],
      })
    );

    getSettings().sonarr = [
      {
        id: 0,
        name: 'Test Sonarr',
        hostname: '127.0.0.1',
        port: 8989,
        apiKey: 'test',
        useSsl: false,
        activeProfileId: 1,
        activeProfileName: 'Any',
        activeDirectory: '/tv',
        tags: [],
        is4k: false,
        isDefault: true,
        syncEnabled: true,
        preventSearch: false,
        tagRequests: false,
        overrideRule: [],
        enableSeasonFolders: true,
        monitorNewItems: 'all',
        seriesType: 'standard',
        animeSeriesType: 'anime',
      },
    ];

    let seriesStatus = 'continuing';
    let episodes = [
      { ...sonarrEpisode(1, 101, 1, true), monitored: false },
      sonarrEpisode(2, 102, 2, false),
    ];
    t.mock.method(
      SonarrAPI.prototype,
      'getSeriesById',
      async () => ({ id: 55, status: seriesStatus }) as SonarrSeries
    );
    t.mock.method(SonarrAPI.prototype, 'getEpisodes', async () => episodes);
    const monitor = t.mock.method(
      SonarrAPI.prototype,
      'monitorEpisodes',
      async () => undefined
    );
    t.mock.method(SonarrAPI.prototype, 'searchEpisodes', async () => undefined);

    await episodeRequestSync.run();
    let updated = await getRepository(MediaRequest).findOneByOrFail({
      id: created.id,
    });
    assert.equal(updated.status, MediaRequestStatus.APPROVED);
    assert.equal(updated.episodes.length, 2);
    assert.equal(updated.tvQuotaUnits, 1);
    assert.deepEqual(monitor.mock.calls[0].arguments[0], [2]);

    seriesStatus = 'ended';
    episodes = episodes.map((episode) => ({
      ...episode,
      hasFile: true,
      monitored: true,
    }));
    await episodeRequestSync.run();
    updated = await getRepository(MediaRequest).findOneByOrFail({
      id: created.id,
    });
    assert.equal(updated.status, MediaRequestStatus.COMPLETED);
    assert.ok(
      updated.episodes.every(
        (episode) => episode.status === MediaRequestStatus.COMPLETED
      )
    );
  });

  it('looks up the series on the request Sonarr when media IDs belong to another server', async (t: TestContext) => {
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 9002,
        tvdbId: 8002,
        mediaType: MediaType.TV,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.UNKNOWN,
        serviceId: 0,
        externalServiceId: 55,
      })
    );
    const created = await getRepository(MediaRequest).save(
      new MediaRequest({
        media,
        requestedBy: user,
        type: MediaType.TV,
        status: MediaRequestStatus.APPROVED,
        is4k: false,
        serverId: 1,
        seasons: [],
        episodeSelectionType: 'after',
        episodeStartTvdbId: 201,
        tvQuotaUnits: 1,
        episodes: [
          new EpisodeRequest({
            tvdbId: 201,
            seasonNumber: 1,
            episodeNumber: 1,
            status: MediaRequestStatus.APPROVED,
          }),
        ],
      })
    );

    const sonarrServer = {
      name: 'Test Sonarr',
      hostname: '127.0.0.1',
      port: 8989,
      apiKey: 'test',
      useSsl: false,
      activeProfileId: 1,
      activeProfileName: 'Any',
      activeDirectory: '/tv',
      tags: [],
      is4k: false,
      isDefault: false,
      syncEnabled: true,
      preventSearch: false,
      tagRequests: false,
      overrideRule: [],
      enableSeasonFolders: true,
      monitorNewItems: 'all' as const,
      seriesType: 'standard' as const,
      animeSeriesType: 'anime' as const,
    };
    getSettings().sonarr = [
      { ...sonarrServer, id: 0, isDefault: true },
      { ...sonarrServer, id: 1, hostname: '10.0.0.2' },
    ];

    t.mock.method(SonarrAPI.prototype, 'getSeries', async () => [
      { id: 99, tvdbId: 8002 },
    ]);
    const getSeriesById = t.mock.method(
      SonarrAPI.prototype,
      'getSeriesById',
      async (id: number) => ({ id, status: 'continuing' }) as SonarrSeries
    );
    t.mock.method(SonarrAPI.prototype, 'getEpisodes', async () => [
      sonarrEpisode(3, 201, 1, false),
    ]);
    t.mock.method(
      SonarrAPI.prototype,
      'monitorEpisodes',
      async () => undefined
    );
    t.mock.method(SonarrAPI.prototype, 'searchEpisodes', async () => undefined);

    await episodeRequestSync.run();
    const updated = await getRepository(MediaRequest).findOneByOrFail({
      id: created.id,
    });
    assert.equal(updated.status, MediaRequestStatus.APPROVED);
    assert.deepEqual(
      getSeriesById.mock.calls.map((call) => call.arguments[0]),
      [99]
    );
  });

  it('slides a watch-ahead buffer from watch progress without exceeding N', async (t: TestContext) => {
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 9003,
        tvdbId: 8003,
        mediaType: MediaType.TV,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.UNKNOWN,
        serviceId: 0,
        externalServiceId: 55,
        jellyfinMediaId: 'series-1',
      })
    );
    const created = await getRepository(MediaRequest).save(
      new MediaRequest({
        media,
        requestedBy: user,
        type: MediaType.TV,
        status: MediaRequestStatus.APPROVED,
        is4k: false,
        seasons: [],
        episodeSelectionType: 'watchAhead',
        watchAheadCount: 2,
        tvQuotaUnits: 1,
        episodes: [
          new EpisodeRequest({
            tvdbId: 102,
            seasonNumber: 1,
            episodeNumber: 2,
            status: MediaRequestStatus.APPROVED,
          }),
        ],
      })
    );

    getSettings().sonarr = [
      {
        id: 0,
        name: 'Test Sonarr',
        hostname: '127.0.0.1',
        port: 8989,
        apiKey: 'test',
        useSsl: false,
        activeProfileId: 1,
        activeProfileName: 'Any',
        activeDirectory: '/tv',
        tags: [],
        is4k: false,
        isDefault: true,
        syncEnabled: true,
        preventSearch: false,
        tagRequests: false,
        overrideRule: [],
        enableSeasonFolders: true,
        monitorNewItems: 'all',
        seriesType: 'standard',
        animeSeriesType: 'anime',
      },
    ];

    t.mock.method(Tvdb, 'getInstance', async () => ({
      getEpisodeCatalog: async () => ({
        tvdbSeriesId: 8003,
        episodes: [
          { tvdbId: 101, seasonNumber: 1, episodeNumber: 1, title: 'One' },
          { tvdbId: 102, seasonNumber: 1, episodeNumber: 2, title: 'Two' },
          { tvdbId: 103, seasonNumber: 1, episodeNumber: 3, title: 'Three' },
          { tvdbId: 104, seasonNumber: 1, episodeNumber: 4, title: 'Four' },
        ],
      }),
    }));
    t.mock.method(
      watchAhead,
      'loadPlayedTvdbIdsForSeries',
      async () => new Set([101])
    );
    t.mock.method(
      SonarrAPI.prototype,
      'getSeriesById',
      async () => ({ id: 55, status: 'continuing' }) as SonarrSeries
    );
    t.mock.method(SonarrAPI.prototype, 'getEpisodes', async () => [
      { ...sonarrEpisode(1, 101, 1, true), monitored: true },
      sonarrEpisode(2, 102, 2, false),
      sonarrEpisode(3, 103, 3, false),
      sonarrEpisode(4, 104, 4, false),
    ]);
    const monitor = t.mock.method(
      SonarrAPI.prototype,
      'monitorEpisodes',
      async () => undefined
    );
    t.mock.method(SonarrAPI.prototype, 'searchEpisodes', async () => undefined);

    await episodeRequestSync.run();
    const updated = await getRepository(MediaRequest).findOneByOrFail({
      id: created.id,
    });
    assert.equal(updated.status, MediaRequestStatus.APPROVED);
    assert.deepEqual(
      updated.episodes.map((episode) => episode.tvdbId).sort((a, b) => a - b),
      [102, 103]
    );
    assert.equal(updated.tvQuotaUnits, 1);
    assert.deepEqual(monitor.mock.calls[0].arguments[0], [2, 3]);
  });
});
