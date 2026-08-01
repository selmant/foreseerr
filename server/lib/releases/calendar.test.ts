import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import ReleaseOccurrence from '@server/entity/ReleaseOccurrence';
import {
  normalizeRadarrMovie,
  normalizeSonarrEpisode,
} from '@server/lib/releases/normalization';
import {
  isMaterialDateChange,
  parseProviderDate,
} from '@server/lib/releases/sync';
import type { DVRSettings } from '@server/lib/settings';
import { selectPrimaryRadarrDates } from '@server/routes/calendar';

describe('release calendar date normalization', () => {
  const server = {
    id: 2,
    is4k: false,
    externalUrl: 'https://servarr.example/base',
  } as DVRSettings;

  it('marks date-only provider dates as all-day', () => {
    assert.deepStrictEqual(parseProviderDate('2026-08-04'), {
      startsAt: new Date('2026-08-04T00:00:00.000Z'),
      allDay: true,
    });
    assert.strictEqual(parseProviderDate('not-a-date'), undefined);
  });

  it('uses a one-day threshold for all-day dates and twelve hours for timed dates', () => {
    const allDay = new ReleaseOccurrence({
      startsAt: new Date('2026-08-04T00:00:00.000Z'),
      allDay: true,
    });
    assert.strictEqual(
      isMaterialDateChange(allDay, {
        startsAt: new Date('2026-08-04T12:00:00.000Z'),
        allDay: true,
      } as never),
      false
    );
    const timed = new ReleaseOccurrence({
      startsAt: new Date('2026-08-04T00:00:00.000Z'),
      allDay: false,
    });
    assert.strictEqual(
      isMaterialDateChange(timed, {
        startsAt: new Date('2026-08-04T12:00:00.000Z'),
        allDay: false,
      } as never),
      true
    );
  });

  it('prefers digital, then physical, then theatrical Radarr dates', () => {
    const theatrical = new ReleaseOccurrence({
      id: 1,
      source: 'radarr',
      sourceServerId: 2,
      sourceItemId: 3,
      dateType: 'theatrical',
    });
    const physical = new ReleaseOccurrence({
      id: 2,
      source: 'radarr',
      sourceServerId: 2,
      sourceItemId: 3,
      dateType: 'physical',
    });
    const digital = new ReleaseOccurrence({
      id: 3,
      source: 'radarr',
      sourceServerId: 2,
      sourceItemId: 3,
      dateType: 'digital',
    });
    const tv = new ReleaseOccurrence({
      id: 4,
      source: 'sonarr',
      sourceServerId: 2,
      sourceItemId: 3,
      dateType: 'air',
    });

    assert.deepStrictEqual(
      selectPrimaryRadarrDates([theatrical, physical, digital, tv]),
      [digital, tv]
    );
    assert.deepStrictEqual(
      selectPrimaryRadarrDates([theatrical, physical, digital, tv], 'physical'),
      [physical, tv]
    );
  });

  it('normalizes only populated Radarr dates and preserves their labels', () => {
    const occurrences = normalizeRadarrMovie(
      {
        id: 3,
        tmdbId: 4,
        title: 'Example Movie',
        titleSlug: 'example-movie',
        monitored: true,
        hasFile: false,
        isAvailable: false,
        digitalRelease: '2026-09-01',
        inCinemas: '2026-08-01',
      } as never,
      server
    );

    assert.deepStrictEqual(
      occurrences.map(({ dateType, allDay }) => ({ dateType, allDay })),
      [
        { dateType: 'digital', allDay: true },
        { dateType: 'theatrical', allDay: true },
      ]
    );
    assert.strictEqual(
      occurrences[0].sourceUrl,
      'https://servarr.example/base/movie/example-movie'
    );
  });

  it('normalizes a Sonarr episode with its series identity', () => {
    const [occurrence] = normalizeSonarrEpisode(
      {
        id: 5,
        seriesId: 6,
        tvdbId: 7,
        title: 'Premiere',
        seasonNumber: 2,
        episodeNumber: 1,
        airDateUtc: '2026-10-01T18:00:00Z',
        monitored: true,
        hasFile: false,
        series: {
          tvdbId: 8,
          title: 'Example Series',
          titleSlug: 'example-series',
          monitored: true,
        },
      } as never,
      server
    );

    assert.strictEqual(occurrence.title, 'Example Series');
    assert.strictEqual(occurrence.sourceSeriesTvdbId, 8);
    assert.strictEqual(occurrence.allDay, false);
  });
});
