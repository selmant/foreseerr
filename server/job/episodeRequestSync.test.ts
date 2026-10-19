import assert from 'node:assert/strict';
import {
  afterEach,
  beforeEach,
  describe,
  it,
  mock,
  type TestContext,
} from 'node:test';

import SonarrAPI, {
  type EpisodeResult,
  type SonarrSeries,
} from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
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
import { watchAheadFns } from '@server/lib/watchAhead';
import { setupTestDb } from '@server/test/db';
import episodeRequestSync from './episodeRequestSync';

setupTestDb();

afterEach(() => {
  delete (TheMovieDb.prototype as { get?: unknown }).get;
  mock.restoreAll();
});

beforeEach(() => {
  getSettings().sonarr = [];
  mock.method(MediaRequest, 'sendNotification', async () => undefined);
  // Saving an approved request runs MediaRequestSubscriber.sendToSonarr,
  // which fetches TMDB and swallows failures.
  Object.defineProperty(TheMovieDb.prototype, 'get', {
    configurable: true,
    value: async (endpoint: string) => {
      const tvMatch = /^\/tv\/(\d+)/.exec(endpoint);
      if (tvMatch) {
        return {
          id: Number(tvMatch[1]),
          name: 'Test Show',
          original_language: 'en',
          genres: [],
          keywords: { results: [] },
          external_ids: {},
          seasons: [],
        };
      }
      const movieMatch = /^\/movie\/(\d+)/.exec(endpoint);
      if (movieMatch) {
        return {
          id: Number(movieMatch[1]),
          title: 'Test Movie',
          original_language: 'en',
          genres: [],
          keywords: { keywords: [] },
          external_ids: {},
        };
      }
      throw new Error(`Unexpected TMDB endpoint ${endpoint}`);
    },
  });
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
      watchAheadFns,
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

  it('does not re-monitor a completed watch-ahead episode whose file was deleted', async (t: TestContext) => {
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 9004,
        tvdbId: 8004,
        mediaType: MediaType.TV,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.UNKNOWN,
        serviceId: 0,
        externalServiceId: 55,
        jellyfinMediaId: 'series-2',
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
        watchAheadCount: 1,
        tvQuotaUnits: 1,
        episodes: [
          new EpisodeRequest({
            tvdbId: 101,
            seasonNumber: 1,
            episodeNumber: 1,
            status: MediaRequestStatus.APPROVED,
          }),
          new EpisodeRequest({
            tvdbId: 102,
            seasonNumber: 1,
            episodeNumber: 2,
            status: MediaRequestStatus.APPROVED,
          }),
        ],
      })
    );
    // Episode 1 was downloaded earlier, so its child is already completed.
    await getRepository(EpisodeRequest).update(
      { request: { id: created.id }, tvdbId: 101 },
      { status: MediaRequestStatus.COMPLETED }
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
        tvdbSeriesId: 8004,
        episodes: [
          { tvdbId: 101, seasonNumber: 1, episodeNumber: 1, title: 'One' },
          { tvdbId: 102, seasonNumber: 1, episodeNumber: 2, title: 'Two' },
        ],
      }),
    }));
    t.mock.method(
      watchAheadFns,
      'loadPlayedTvdbIdsForSeries',
      async () => new Set([101])
    );
    t.mock.method(
      SonarrAPI.prototype,
      'getSeriesById',
      async () => ({ id: 55, status: 'continuing' }) as SonarrSeries
    );
    // Episode 1 was watched, then deleted and unmonitored by a cleanup tool.
    t.mock.method(SonarrAPI.prototype, 'getEpisodes', async () => [
      sonarrEpisode(1, 101, 1, false),
      sonarrEpisode(2, 102, 2, false),
    ]);
    const monitor = t.mock.method(
      SonarrAPI.prototype,
      'monitorEpisodes',
      async () => undefined
    );
    const search = t.mock.method(
      SonarrAPI.prototype,
      'searchEpisodes',
      async () => undefined
    );

    await episodeRequestSync.run();
    const updated = await getRepository(MediaRequest).findOneByOrFail({
      id: created.id,
    });
    assert.equal(updated.status, MediaRequestStatus.APPROVED);
    assert.equal(
      updated.episodes.find((episode) => episode.tvdbId === 101)?.status,
      MediaRequestStatus.COMPLETED
    );
    assert.deepEqual(monitor.mock.calls[0].arguments[0], [2]);
    assert.deepEqual(search.mock.calls[0].arguments[0], [2]);
  });

  it('does not search a completed episode that is still monitored after its file was deleted', async (t: TestContext) => {
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 9005,
        tvdbId: 8005,
        mediaType: MediaType.TV,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.UNKNOWN,
        serviceId: 0,
        externalServiceId: 55,
        jellyfinMediaId: 'series-3',
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
        watchAheadCount: 1,
        tvQuotaUnits: 1,
        episodes: [
          new EpisodeRequest({
            tvdbId: 101,
            seasonNumber: 1,
            episodeNumber: 1,
            status: MediaRequestStatus.APPROVED,
          }),
          new EpisodeRequest({
            tvdbId: 102,
            seasonNumber: 1,
            episodeNumber: 2,
            status: MediaRequestStatus.APPROVED,
          }),
        ],
      })
    );
    // Episode 1 was downloaded earlier, so its child is already completed.
    await getRepository(EpisodeRequest).update(
      { request: { id: created.id }, tvdbId: 101 },
      { status: MediaRequestStatus.COMPLETED }
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
        tvdbSeriesId: 8005,
        episodes: [
          { tvdbId: 101, seasonNumber: 1, episodeNumber: 1, title: 'One' },
          { tvdbId: 102, seasonNumber: 1, episodeNumber: 2, title: 'Two' },
        ],
      }),
    }));
    t.mock.method(
      watchAheadFns,
      'loadPlayedTvdbIdsForSeries',
      async () => new Set([101])
    );
    t.mock.method(
      SonarrAPI.prototype,
      'getSeriesById',
      async () => ({ id: 55, status: 'continuing' }) as SonarrSeries
    );
    // Episode 1's file was deleted, but Sonarr still monitors it.
    t.mock.method(SonarrAPI.prototype, 'getEpisodes', async () => [
      { ...sonarrEpisode(1, 101, 1, false), monitored: true },
      sonarrEpisode(2, 102, 2, false),
    ]);
    const monitor = t.mock.method(
      SonarrAPI.prototype,
      'monitorEpisodes',
      async () => undefined
    );
    const search = t.mock.method(
      SonarrAPI.prototype,
      'searchEpisodes',
      async () => undefined
    );

    await episodeRequestSync.run();
    const updated = await getRepository(MediaRequest).findOneByOrFail({
      id: created.id,
    });
    assert.equal(updated.status, MediaRequestStatus.APPROVED);
    assert.equal(
      updated.episodes.find((episode) => episode.tvdbId === 101)?.status,
      MediaRequestStatus.COMPLETED
    );
    assert.deepEqual(monitor.mock.calls[0].arguments[0], [2]);
    assert.deepEqual(search.mock.calls[0].arguments[0], [2]);
  });
});

describe('watch-ahead monitoring owned by Sonarr', () => {
  const catalogEpisodes = [101, 102, 103, 104].map((tvdbId, index) => ({
    tvdbId,
    seasonNumber: 1,
    episodeNumber: index + 1,
    title: `Episode ${index + 1}`,
  }));

  // Creates an approved watch-ahead request whose children are given as
  // tvdbId → fields, with Sonarr 0 configured as the default server.
  const createWatchAheadRequest = async (
    watchAheadCount: number,
    children: Record<number, Partial<EpisodeRequest>>
  ): Promise<MediaRequest> => {
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 9010,
        tvdbId: 8010,
        mediaType: MediaType.TV,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.UNKNOWN,
        serviceId: 0,
        externalServiceId: 55,
        jellyfinMediaId: 'series-10',
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
        watchAheadCount,
        tvQuotaUnits: 1,
        episodes: Object.keys(children).map(
          (tvdbId) =>
            new EpisodeRequest({
              tvdbId: Number(tvdbId),
              seasonNumber: 1,
              episodeNumber: Number(tvdbId) - 100,
              status: MediaRequestStatus.APPROVED,
            })
        ),
      })
    );
    // Saving the request through the subscriber resets child fields, so the
    // tracking state is written afterwards.
    for (const [tvdbId, fields] of Object.entries(children)) {
      if (Object.keys(fields).length > 0) {
        await getRepository(EpisodeRequest).update(
          { request: { id: created.id }, tvdbId: Number(tvdbId) },
          fields
        );
      }
    }

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
    return created;
  };

  // Mocks TVDB, Jellyfin progress and Sonarr. The returned state can be
  // changed between sync runs to simulate other tools.
  const mockServices = (
    t: TestContext,
    initial: {
      played: Set<number> | undefined;
      episodes: EpisodeResult[];
    }
  ) => {
    const state = { ...initial };
    t.mock.method(Tvdb, 'getInstance', async () => ({
      getEpisodeCatalog: async () => ({
        tvdbSeriesId: 8010,
        episodes: catalogEpisodes,
      }),
    }));
    t.mock.method(
      watchAheadFns,
      'loadPlayedTvdbIdsForSeries',
      async () => state.played
    );
    t.mock.method(
      SonarrAPI.prototype,
      'getSeriesById',
      async () => ({ id: 55, status: 'continuing' }) as SonarrSeries
    );
    t.mock.method(SonarrAPI.prototype, 'getEpisodes', async () =>
      state.episodes.map((episode) => ({ ...episode }))
    );
    const monitor = t.mock.method(
      SonarrAPI.prototype,
      'monitorEpisodes',
      async () => undefined
    );
    const search = t.mock.method(
      SonarrAPI.prototype,
      'searchEpisodes',
      async () => undefined
    );
    return { state, monitor, search };
  };

  const loadRequest = (id: number) =>
    getRepository(MediaRequest).findOneByOrFail({ id });

  const child = (request: MediaRequest, tvdbId: number) => {
    const found = request.episodes.find((episode) => episode.tvdbId === tvdbId);
    assert.ok(found, `child ${tvdbId} exists`);
    return found;
  };

  it('monitors a watch-ahead episode once and leaves it unmonitored after a cleanup tool removes it', async (t: TestContext) => {
    const created = await createWatchAheadRequest(2, {
      101: { status: MediaRequestStatus.COMPLETED },
      102: {},
      103: {},
    });
    const { state, monitor, search } = mockServices(t, {
      played: new Set([101]),
      episodes: [
        sonarrEpisode(1, 101, 1, false),
        sonarrEpisode(2, 102, 2, false),
        // Already monitored, for example by the series monitor setting.
        { ...sonarrEpisode(3, 103, 3, false), monitored: true },
      ],
    });

    await episodeRequestSync.run();
    let updated = await loadRequest(created.id);
    assert.deepEqual(monitor.mock.calls[0].arguments[0], [2]);
    assert.deepEqual(search.mock.calls[0].arguments[0], [2, 3]);
    assert.ok(child(updated, 102).monitoredAt);
    assert.ok(child(updated, 103).monitoredAt);
    assert.equal(child(updated, 102).unmonitoredAt ?? null, null);
    assert.equal(updated.watchAheadInactiveAt ?? null, null);

    // A cleanup tool unmonitors episode 2 before it is downloaded.
    state.episodes = [
      sonarrEpisode(1, 101, 1, false),
      sonarrEpisode(2, 102, 2, false),
      { ...sonarrEpisode(3, 103, 3, false), monitored: true },
    ];
    monitor.mock.resetCalls();
    search.mock.resetCalls();
    await episodeRequestSync.run();
    updated = await loadRequest(created.id);
    assert.deepEqual(monitor.mock.calls[0].arguments[0], []);
    assert.equal(search.mock.callCount(), 0);
    assert.ok(child(updated, 102).unmonitoredAt);
    assert.equal(child(updated, 103).unmonitoredAt ?? null, null);
    // Episode 3 is still wanted, so the request is still active.
    assert.equal(updated.watchAheadInactiveAt ?? null, null);
    assert.equal(updated.status, MediaRequestStatus.APPROVED);
  });

  it('marks the request inactive while every window episode is removed and clears it when the window moves on', async (t: TestContext) => {
    const created = await createWatchAheadRequest(2, {
      101: { status: MediaRequestStatus.COMPLETED },
      102: { monitoredAt: new Date() },
      // Downloaded earlier, then deleted unwatched.
      103: { status: MediaRequestStatus.COMPLETED },
    });
    const { state, monitor, search } = mockServices(t, {
      played: new Set([101]),
      episodes: [
        sonarrEpisode(1, 101, 1, false),
        sonarrEpisode(2, 102, 2, false),
        sonarrEpisode(3, 103, 3, false),
        sonarrEpisode(4, 104, 4, false),
      ],
    });

    await episodeRequestSync.run();
    let updated = await loadRequest(created.id);
    assert.deepEqual(monitor.mock.calls[0].arguments[0], []);
    assert.equal(search.mock.callCount(), 0);
    assert.ok(child(updated, 102).unmonitoredAt);
    assert.ok(child(updated, 103).unmonitoredAt);
    assert.ok(updated.watchAheadInactiveAt);
    assert.equal(updated.status, MediaRequestStatus.APPROVED);

    // Watching episode 2 moves the window to episodes 3 and 4.
    state.played = new Set([101, 102]);
    monitor.mock.resetCalls();
    await episodeRequestSync.run();
    updated = await loadRequest(created.id);
    assert.deepEqual(monitor.mock.calls[0].arguments[0], [4]);
    assert.equal(child(updated, 102).unmonitoredAt ?? null, null);
    assert.ok(child(updated, 103).unmonitoredAt);
    assert.equal(updated.watchAheadInactiveAt ?? null, null);
  });

  it('clears the removed state when the episode is monitored again', async (t: TestContext) => {
    const created = await createWatchAheadRequest(1, {
      101: { status: MediaRequestStatus.COMPLETED },
      102: { monitoredAt: new Date(), unmonitoredAt: new Date() },
    });
    await getRepository(MediaRequest).update(created.id, {
      watchAheadInactiveAt: new Date(),
    });
    mockServices(t, {
      played: new Set([101]),
      episodes: [
        sonarrEpisode(1, 101, 1, false),
        { ...sonarrEpisode(2, 102, 2, false), monitored: true },
      ],
    });

    await episodeRequestSync.run();
    const updated = await loadRequest(created.id);
    assert.equal(child(updated, 102).unmonitoredAt ?? null, null);
    assert.equal(updated.watchAheadInactiveAt ?? null, null);
  });

  it('does not mark episodes as monitored when Sonarr rejects the update', async (t: TestContext) => {
    const created = await createWatchAheadRequest(1, {
      101: { status: MediaRequestStatus.COMPLETED },
      102: {},
    });
    const { monitor } = mockServices(t, {
      played: new Set([101]),
      episodes: [
        sonarrEpisode(1, 101, 1, false),
        sonarrEpisode(2, 102, 2, false),
      ],
    });
    monitor.mock.mockImplementation(async () => {
      throw new Error('Sonarr is down');
    });

    await episodeRequestSync.run();
    const updated = await loadRequest(created.id);
    assert.equal(child(updated, 102).monitoredAt ?? null, null);
  });

  it('tracks a downloaded window episode as completed without searching it', async (t: TestContext) => {
    const created = await createWatchAheadRequest(2, {
      101: { status: MediaRequestStatus.COMPLETED },
    });
    const { state, monitor, search } = mockServices(t, {
      played: new Set([101]),
      episodes: [
        sonarrEpisode(1, 101, 1, false),
        sonarrEpisode(2, 102, 2, true),
        sonarrEpisode(3, 103, 3, false),
      ],
    });

    await episodeRequestSync.run();
    let updated = await loadRequest(created.id);
    assert.equal(child(updated, 102).status, MediaRequestStatus.COMPLETED);
    assert.equal(child(updated, 103).status, MediaRequestStatus.APPROVED);
    assert.deepEqual(monitor.mock.calls[0].arguments[0], [3]);
    assert.deepEqual(search.mock.calls[0].arguments[0], [3]);

    // Episode 2 is deleted unwatched. It must not be requested again.
    state.episodes = [
      sonarrEpisode(1, 101, 1, false),
      sonarrEpisode(2, 102, 2, false),
      { ...sonarrEpisode(3, 103, 3, false), monitored: true },
    ];
    monitor.mock.resetCalls();
    search.mock.resetCalls();
    await episodeRequestSync.run();
    updated = await loadRequest(created.id);
    assert.deepEqual(monitor.mock.calls[0].arguments[0], []);
    assert.equal(search.mock.callCount(), 0);
    assert.ok(child(updated, 102).unmonitoredAt);
    assert.equal(updated.watchAheadInactiveAt ?? null, null);
  });

  it('does not move the window when watch progress cannot be loaded', async (t: TestContext) => {
    const created = await createWatchAheadRequest(1, {
      101: { status: MediaRequestStatus.COMPLETED },
      102: { status: MediaRequestStatus.COMPLETED },
      103: {
        monitoredAt: new Date(),
        unmonitoredAt: new Date(),
        searchTriggeredAt: new Date(),
      },
    });
    const { monitor, search } = mockServices(t, {
      played: undefined,
      episodes: [
        sonarrEpisode(1, 101, 1, false),
        sonarrEpisode(2, 102, 2, false),
        { ...sonarrEpisode(3, 103, 3, false), monitored: true },
      ],
    });

    await episodeRequestSync.run();
    const updated = await loadRequest(created.id);
    assert.equal(updated.episodes.length, 3);
    assert.deepEqual(monitor.mock.calls[0].arguments[0], []);
    assert.equal(search.mock.callCount(), 0);
    // Without a window the removed state is left as it was.
    assert.ok(child(updated, 103).unmonitoredAt);
  });
});
