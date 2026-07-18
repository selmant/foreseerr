import { MediaType } from '@server/constants/media';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  resolveAnimeSonarrRouting,
  resolveRequestProfileRouting,
} from './routing';
import { DEFAULT_REQUEST_FILTERS } from './types';

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
        filters: DEFAULT_REQUEST_FILTERS,
        is4k: false,
        isAnime: false,
      }),
      null
    );
  });

  it('uses default server anime profile when no dedicated server', () => {
    const result = resolveAnimeSonarrRouting({
      sonarr: [baseSonarr({})],
      filters: DEFAULT_REQUEST_FILTERS,
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
      filters: {
        ...DEFAULT_REQUEST_FILTERS,
        profileRouting: {
          ...DEFAULT_REQUEST_FILTERS.profileRouting,
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

  it('falls back to default when dedicated id is missing', () => {
    const result = resolveAnimeSonarrRouting({
      sonarr: [baseSonarr({})],
      filters: {
        ...DEFAULT_REQUEST_FILTERS,
        animeSonarrServerId: 99,
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
      filters: {
        ...DEFAULT_REQUEST_FILTERS,
        profileRouting: {
          ...DEFAULT_REQUEST_FILTERS.profileRouting,
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
      filters: {
        ...DEFAULT_REQUEST_FILTERS,
        profileRouting: {
          ...DEFAULT_REQUEST_FILTERS.profileRouting,
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
