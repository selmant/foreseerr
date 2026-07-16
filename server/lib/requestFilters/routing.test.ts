import type { SonarrSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveAnimeSonarrRouting } from './routing';
import { DEFAULT_REQUEST_FILTERS } from './types';

const baseServer = (overrides: Partial<SonarrSettings>): SonarrSettings =>
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

describe('resolveAnimeSonarrRouting', () => {
  it('returns null for non-anime', () => {
    assert.equal(
      resolveAnimeSonarrRouting({
        sonarr: [baseServer({})],
        filters: DEFAULT_REQUEST_FILTERS,
        is4k: false,
        isAnime: false,
      }),
      null
    );
  });

  it('uses default server anime profile when no dedicated server', () => {
    const result = resolveAnimeSonarrRouting({
      sonarr: [baseServer({})],
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
    const animeServer = baseServer({
      id: 2,
      name: 'Anime',
      isDefault: false,
      activeAnimeProfileId: 12,
      activeAnimeDirectory: '/anime-dedicated',
    });
    const result = resolveAnimeSonarrRouting({
      sonarr: [baseServer({}), animeServer],
      filters: {
        ...DEFAULT_REQUEST_FILTERS,
        animeSonarrServerId: 2,
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
      sonarr: [baseServer({})],
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
