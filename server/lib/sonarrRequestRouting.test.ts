import { MediaStatus } from '@server/constants/media';
import type { SonarrSettings } from '@server/lib/settings';
import {
  applySonarrRequestDefaults,
  resolveSonarrSeriesRouting,
  shouldShortCircuitAvailableTvRequest,
} from '@server/lib/sonarrRequestRouting';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const sonarrSettings = {
  id: 5,
  seriesType: 'standard',
  animeSeriesType: 'standard',
  activeDirectory: '/tv',
  activeAnimeDirectory: '/anime',
  activeProfileId: 1,
  activeAnimeProfileId: 8,
  activeLanguageProfileId: 2,
  activeAnimeLanguageProfileId: 9,
  tags: [10],
  animeTags: [20],
} as SonarrSettings;

describe('shouldShortCircuitAvailableTvRequest', () => {
  it('still completes a whole-show request when the series is already available', () => {
    assert.equal(
      shouldShortCircuitAvailableTvRequest(
        { is4k: false, episodes: [], episodeSelectionType: undefined },
        { status: MediaStatus.AVAILABLE, status4k: MediaStatus.UNKNOWN }
      ),
      true
    );
  });

  it('sends episode selections for an available series to Sonarr', () => {
    assert.equal(
      shouldShortCircuitAvailableTvRequest(
        {
          is4k: false,
          episodes: [{ tvdbId: 1 } as never],
          episodeSelectionType: 'after',
        },
        { status: MediaStatus.AVAILABLE, status4k: MediaStatus.UNKNOWN }
      ),
      false
    );
    assert.equal(
      shouldShortCircuitAvailableTvRequest(
        {
          is4k: false,
          episodes: [],
          episodeSelectionType: 'range',
        },
        { status: MediaStatus.AVAILABLE, status4k: MediaStatus.UNKNOWN }
      ),
      false
    );
  });
});

describe('resolveSonarrSeriesRouting', () => {
  it('routes anime by isAnime even when seriesType is not anime', () => {
    const routing = resolveSonarrSeriesRouting(sonarrSettings, true);
    assert.equal(routing.seriesType, 'standard');
    assert.equal(routing.rootFolder, '/anime');
    assert.equal(routing.qualityProfile, 8);
    assert.equal(routing.languageProfile, 9);
    assert.deepEqual(routing.tags, [20]);
  });

  it('applies the configured non-anime series type', () => {
    const routing = resolveSonarrSeriesRouting(
      { ...sonarrSettings, seriesType: 'daily' },
      false
    );
    assert.equal(routing.seriesType, 'daily');
    assert.equal(routing.rootFolder, '/tv');
    assert.equal(routing.qualityProfile, 1);
    assert.deepEqual(routing.tags, [10]);
  });
});

describe('applySonarrRequestDefaults', () => {
  it('stamps anime quality profile and anime tags on instant requests', () => {
    const defaults = applySonarrRequestDefaults(sonarrSettings, true, {});
    assert.equal(defaults.serverId, 5);
    assert.equal(defaults.profileId, 8);
    assert.equal(defaults.rootFolder, '/anime');
    assert.equal(defaults.languageProfileId, 9);
    assert.deepEqual(defaults.tags, [20]);
  });

  it('still applies the anime profile when only anime tags were provided', () => {
    const defaults = applySonarrRequestDefaults(sonarrSettings, true, {
      tags: [20],
    });
    assert.equal(defaults.profileId, 8);
    assert.deepEqual(defaults.tags, [20]);
  });

  it('keeps an explicit quality profile from the request modal', () => {
    const defaults = applySonarrRequestDefaults(sonarrSettings, true, {
      profileId: 3,
      tags: [99],
    });
    assert.equal(defaults.profileId, 3);
    assert.deepEqual(defaults.tags, [99]);
  });

  it('uses the non-anime Sonarr defaults when the title is not anime', () => {
    const defaults = applySonarrRequestDefaults(sonarrSettings, false, {});
    assert.equal(defaults.profileId, 1);
    assert.equal(defaults.rootFolder, '/tv');
    assert.deepEqual(defaults.tags, [10]);
  });
});
