import { MediaType } from '@server/constants/media';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RequestRoutingError,
  resolveAnimeSonarrRouting,
  resolveAtomicRequestRouting,
  resolveRequestProfileRouting,
} from './routing';
import { DEFAULT_REQUEST_ROUTING } from './types';

const baseSonarr = (overrides: Partial<SonarrSettings>): SonarrSettings =>
  ({
    id: 1,
    name: 'Sonarr',
    hostname: 'localhost',
    port: 8989,
    apiKey: 'x',
    useSsl: false,
    activeProfileId: 1,
    activeProfileName: 'HD',
    activeDirectory: '/tv',
    tags: [1],
    is4k: false,
    isDefault: true,
    syncEnabled: true,
    preventSearch: false,
    tagRequests: false,
    overrideRule: [],
    seriesType: 'standard',
    animeSeriesType: 'anime',
    activeAnimeProfileId: 9,
    activeAnimeDirectory: '/anime',
    activeAnimeLanguageProfileId: 2,
    activeLanguageProfileId: 4,
    animeTags: [9],
    enableSeasonFolders: true,
    monitorNewItems: 'all',
    ...overrides,
  }) as SonarrSettings;

const baseRadarr = (overrides: Partial<RadarrSettings>): RadarrSettings =>
  ({
    id: 10,
    name: 'Radarr',
    hostname: 'localhost',
    port: 7878,
    apiKey: 'x',
    useSsl: false,
    activeProfileId: 3,
    activeProfileName: 'HD',
    activeDirectory: '/movies',
    tags: [2],
    is4k: false,
    isDefault: true,
    syncEnabled: true,
    preventSearch: false,
    tagRequests: false,
    overrideRule: [],
    minimumAvailability: 'released',
    ...overrides,
  }) as RadarrSettings;

describe('resolveAnimeSonarrRouting', () => {
  it('returns null for non-anime', () => {
    assert.equal(
      resolveAnimeSonarrRouting({
        sonarr: [baseSonarr({})],
        routing: DEFAULT_REQUEST_ROUTING,
        is4k: false,
        isAnime: false,
      }),
      null
    );
  });

  it('uses default server anime profile when no dedicated server', () => {
    const result = resolveAnimeSonarrRouting({
      sonarr: [baseSonarr({})],
      routing: DEFAULT_REQUEST_ROUTING,
      is4k: false,
      isAnime: true,
    });
    assert.equal(result?.serverId, 1);
    assert.equal(result?.profileId, 9);
    assert.equal(result?.rootFolder, '/anime');
    assert.deepEqual(result?.tags, [9]);
  });

  it('prefers dedicated anime Sonarr server when configured', () => {
    const animeServer = baseSonarr({
      id: 2,
      name: 'Anime',
      isDefault: false,
      activeAnimeProfileId: 12,
      activeAnimeDirectory: '/anime-dedicated',
    });
    const result = resolveAnimeSonarrRouting({
      sonarr: [baseSonarr({}), animeServer],
      routing: {
        ...DEFAULT_REQUEST_ROUTING,
        profileRouting: {
          ...DEFAULT_REQUEST_ROUTING.profileRouting,
          animeTv: {
            serverId: 2,
            profileId: null,
            rootFolder: null,
            languageProfileId: null,
          },
        },
      },
      is4k: false,
      isAnime: true,
    });
    assert.equal(result?.serverId, 2);
    assert.equal(result?.profileId, 12);
    assert.equal(result?.rootFolder, '/anime-dedicated');
  });

  it('falls back to default when configured server id is missing', () => {
    const result = resolveAnimeSonarrRouting({
      sonarr: [baseSonarr({})],
      routing: {
        ...DEFAULT_REQUEST_ROUTING,
        profileRouting: {
          ...DEFAULT_REQUEST_ROUTING.profileRouting,
          animeTv: {
            serverId: 99,
            profileId: null,
            rootFolder: null,
            languageProfileId: null,
          },
        },
      },
      is4k: false,
      isAnime: true,
    });
    assert.equal(result?.serverId, 1);
  });
});

describe('resolveRequestProfileRouting', () => {
  it('routes default movies to configured radarr profile', () => {
    const radarr = baseRadarr({
      id: 11,
      isDefault: false,
      activeProfileId: 3,
      activeDirectory: '/movies',
    });
    const result = resolveRequestProfileRouting({
      mediaType: MediaType.MOVIE,
      isAnime: false,
      is4k: false,
      routing: {
        ...DEFAULT_REQUEST_ROUTING,
        profileRouting: {
          ...DEFAULT_REQUEST_ROUTING.profileRouting,
          defaultMovie: {
            serverId: 11,
            profileId: 7,
            rootFolder: '/movies-4k',
            languageProfileId: null,
          },
        },
      },
      radarr: [baseRadarr({}), radarr],
      sonarr: [baseSonarr({})],
    });

    assert.equal(result?.serverId, 11);
    assert.equal(result?.profileId, 7);
    assert.equal(result?.rootFolder, '/movies-4k');
  });

  it('routes anime movies separately from default movies', () => {
    const animeRadarr = baseRadarr({
      id: 12,
      isDefault: false,
      activeDirectory: '/anime-movies',
      activeProfileId: 8,
    });
    const result = resolveRequestProfileRouting({
      mediaType: MediaType.MOVIE,
      isAnime: true,
      is4k: false,
      routing: {
        ...DEFAULT_REQUEST_ROUTING,
        profileRouting: {
          ...DEFAULT_REQUEST_ROUTING.profileRouting,
          animeMovie: {
            serverId: 12,
            profileId: 15,
            rootFolder: '/anime-movies',
            languageProfileId: null,
          },
        },
      },
      radarr: [baseRadarr({}), animeRadarr],
      sonarr: [baseSonarr({})],
    });

    assert.equal(result?.kind, 'animeMovie');
    assert.equal(result?.serverId, 12);
    assert.equal(result?.profileId, 15);
  });
});

describe('resolveAtomicRequestRouting', () => {
  it('resolves default TV routing from configured route', () => {
    const sonarr = baseSonarr({
      id: 3,
      isDefault: false,
      activeProfileId: 1,
      activeDirectory: '/tv',
    });
    const result = resolveAtomicRequestRouting({
      mediaType: MediaType.TV,
      isAnime: false,
      is4k: false,
      routing: {
        ...DEFAULT_REQUEST_ROUTING,
        profileRouting: {
          ...DEFAULT_REQUEST_ROUTING.profileRouting,
          defaultTv: {
            serverId: 3,
            profileId: 5,
            rootFolder: '/tv-hd',
            languageProfileId: 4,
          },
        },
      },
      radarr: [baseRadarr({})],
      sonarr: [baseSonarr({}), sonarr],
    });

    assert.equal(result.kind, 'defaultTv');
    assert.equal(result.serverId, 3);
    assert.equal(result.profileId, 5);
    assert.equal(result.rootFolder, '/tv-hd');
    assert.equal(result.languageProfileId, 4);
  });

  it('resolves anime TV with anime defaults', () => {
    const result = resolveAtomicRequestRouting({
      mediaType: MediaType.TV,
      isAnime: true,
      is4k: false,
      routing: DEFAULT_REQUEST_ROUTING,
      radarr: [baseRadarr({})],
      sonarr: [baseSonarr({})],
    });

    assert.equal(result.kind, 'animeTv');
    assert.equal(result.serverId, 1);
    assert.equal(result.profileId, 9);
    assert.equal(result.rootFolder, '/anime');
    assert.equal(result.languageProfileId, 2);
    assert.deepEqual(result.tags, [9]);
    assert.equal(result.seriesType, 'anime');
  });

  it('uses 4K servers for 4K requests', () => {
    const radarr4k = baseRadarr({
      id: 20,
      is4k: true,
      isDefault: true,
      activeProfileId: 30,
      activeDirectory: '/movies-4k',
      tags: [20],
    });
    const result = resolveAtomicRequestRouting({
      mediaType: MediaType.MOVIE,
      isAnime: false,
      is4k: true,
      routing: DEFAULT_REQUEST_ROUTING,
      radarr: [baseRadarr({}), radarr4k],
      sonarr: [baseSonarr({})],
    });

    assert.equal(result.serverId, 20);
    assert.equal(result.profileId, 30);
    assert.equal(result.rootFolder, '/movies-4k');
    assert.deepEqual(result.tags, [20]);
  });

  it('derives missing values from an explicit server instead of another route', () => {
    const alternateRadarr = baseRadarr({
      id: 11,
      isDefault: false,
      activeProfileId: 99,
      activeDirectory: '/alt-movies',
      tags: [11],
    });
    const result = resolveAtomicRequestRouting({
      mediaType: MediaType.MOVIE,
      isAnime: false,
      is4k: false,
      routing: {
        ...DEFAULT_REQUEST_ROUTING,
        profileRouting: {
          ...DEFAULT_REQUEST_ROUTING.profileRouting,
          defaultMovie: {
            serverId: 10,
            profileId: 7,
            rootFolder: '/movies-routed',
            languageProfileId: null,
          },
        },
      },
      radarr: [baseRadarr({}), alternateRadarr],
      sonarr: [baseSonarr({})],
      overrides: {
        serverId: 11,
      },
    });

    assert.equal(result.serverId, 11);
    assert.equal(result.profileId, 99);
    assert.equal(result.rootFolder, '/alt-movies');
    assert.deepEqual(result.tags, [11]);
  });

  it('allows partial overrides on the resolved server', () => {
    const radarr = baseRadarr({
      id: 11,
      isDefault: false,
      activeProfileId: 3,
      activeDirectory: '/movies',
    });
    const result = resolveAtomicRequestRouting({
      mediaType: MediaType.MOVIE,
      isAnime: false,
      is4k: false,
      routing: {
        ...DEFAULT_REQUEST_ROUTING,
        profileRouting: {
          ...DEFAULT_REQUEST_ROUTING.profileRouting,
          defaultMovie: {
            serverId: 11,
            profileId: 7,
            rootFolder: '/movies-routed',
            languageProfileId: null,
          },
        },
      },
      radarr: [baseRadarr({}), radarr],
      sonarr: [baseSonarr({})],
      overrides: {
        profileId: 3,
      },
    });

    assert.equal(result.serverId, 11);
    assert.equal(result.profileId, 3);
    assert.equal(result.rootFolder, '/movies-routed');
  });

  it('rejects cross-server root folders', () => {
    const alternateRadarr = baseRadarr({
      id: 11,
      isDefault: false,
      activeProfileId: 99,
      activeDirectory: '/alt-movies',
    });

    assert.throws(
      () =>
        resolveAtomicRequestRouting({
          mediaType: MediaType.MOVIE,
          isAnime: false,
          is4k: false,
          routing: {
            ...DEFAULT_REQUEST_ROUTING,
            profileRouting: {
              ...DEFAULT_REQUEST_ROUTING.profileRouting,
              defaultMovie: {
                serverId: 10,
                profileId: 7,
                rootFolder: '/movies-routed',
                languageProfileId: null,
              },
            },
          },
          radarr: [baseRadarr({}), alternateRadarr],
          sonarr: [baseSonarr({})],
          overrides: {
            serverId: 11,
            rootFolder: '/movies-routed',
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof RequestRoutingError);
        assert.match(
          error.message,
          /root folder is not valid for the chosen server/i
        );
        return true;
      }
    );
  });

  it('rejects tags from another server', () => {
    assert.throws(
      () =>
        resolveAtomicRequestRouting({
          mediaType: MediaType.MOVIE,
          isAnime: false,
          is4k: false,
          routing: DEFAULT_REQUEST_ROUTING,
          radarr: [baseRadarr({})],
          sonarr: [baseSonarr({})],
          overrides: {
            tags: [99],
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof RequestRoutingError);
        assert.match(error.message, /tags are not valid/i);
        return true;
      }
    );
  });

  it('rejects unavailable explicit servers', () => {
    assert.throws(
      () =>
        resolveAtomicRequestRouting({
          mediaType: MediaType.MOVIE,
          isAnime: false,
          is4k: false,
          routing: DEFAULT_REQUEST_ROUTING,
          radarr: [baseRadarr({})],
          sonarr: [baseSonarr({})],
          overrides: {
            serverId: 404,
          },
        }),
      RequestRoutingError
    );
  });
});
