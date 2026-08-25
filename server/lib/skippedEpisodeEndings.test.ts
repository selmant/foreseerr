import type { JellyfinLibraryItemExtended } from '@server/api/jellyfin';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  episodeProgress,
  frontierEpisodeId,
  isStaleSkippedEpisode,
} from './skippedEpisodeEndings';

const episode = (
  id: string,
  season: number | undefined,
  number: number | undefined,
  userData: JellyfinLibraryItemExtended['UserData'] = {},
  seriesId: string | undefined = 'series'
): JellyfinLibraryItemExtended =>
  ({
    Id: id,
    Name: id,
    Type: 'Episode',
    LocationType: 'FileSystem',
    HasSubtitles: false,
    MediaType: 'Video',
    ProviderIds: {},
    SeriesId: seriesId,
    ParentIndexNumber: season,
    IndexNumber: number,
    UserData: userData,
  }) as JellyfinLibraryItemExtended;

describe('skipped episode ending classification', () => {
  it('requires 50 percent and genuine later viewing activity', () => {
    const laterWatched = episode('e2', 1, 2, {
      Played: true,
      LastPlayedDate: '2026-08-23T19:00:00Z',
    });
    assert.equal(
      isStaleSkippedEpisode(
        episode('e1', 1, 1, {
          PlayedPercentage: 49,
          LastPlayedDate: '2026-08-23T18:00:00Z',
        }),
        [laterWatched]
      ),
      false
    );
    assert.equal(
      isStaleSkippedEpisode(
        episode('e1', 1, 1, {
          PlayedPercentage: 50,
          LastPlayedDate: '2026-08-23T18:00:00Z',
        }),
        [laterWatched]
      ),
      true
    );
    assert.equal(
      isStaleSkippedEpisode(episode('e1', 1, 1, { PlayedPercentage: 50 }), [
        episode('e2', 1, 2),
      ]),
      false
    );
  });

  it('uses tick progress and clamps it to the valid range', () => {
    assert.equal(
      episodeProgress(
        episode('e1', 1, 1, {
          PlaybackPositionTicks: 50,
          RunTimeTicks: 100,
        })
      ),
      50
    );
    assert.equal(
      episodeProgress(
        episode('e1', 1, 1, {
          PlaybackPositionTicks: 200,
          RunTimeTicks: 100,
        })
      ),
      100
    );
  });

  it('accepts partial later playback and orders across regular seasons', () => {
    assert.equal(
      isStaleSkippedEpisode(episode('e1', 1, 12, { PlayedPercentage: 50 }), [
        episode('e2', 2, 1, { PlaybackPositionTicks: 1 }),
      ]),
      true
    );
  });

  it('ignores other series, specials, movies, and missing coordinates', () => {
    const candidate = episode('e1', 1, 1, { PlayedPercentage: 75 });
    assert.equal(
      isStaleSkippedEpisode(candidate, [
        episode('other', 1, 2, { Played: true }, 'other-series'),
      ]),
      false
    );
    assert.equal(
      isStaleSkippedEpisode(candidate, [
        episode('special', 0, 99, { Played: true }),
      ]),
      false
    );
    assert.equal(
      isStaleSkippedEpisode({ ...candidate, Type: 'Movie' }, [
        episode('e2', 1, 2, { Played: true }),
      ]),
      false
    );
    assert.equal(
      isStaleSkippedEpisode(
        episode('missing', undefined, 1, { PlayedPercentage: 75 }),
        [episode('e2', 1, 2, { Played: true })]
      ),
      false
    );
  });

  it('identifies multiple stale episodes but retains the newest active one', () => {
    const e1 = episode('e1', 1, 1, { PlayedPercentage: 70 });
    const e2 = episode('e2', 1, 2, { PlayedPercentage: 60 });
    const e3 = episode('e3', 1, 3, { PlayedPercentage: 20 });
    const all = [e1, e2, e3];
    assert.equal(isStaleSkippedEpisode(e1, all), true);
    assert.equal(isStaleSkippedEpisode(e2, all), true);
    assert.equal(isStaleSkippedEpisode(e3, all), false);
  });

  it('does not mark a season finale when only later seasons were watched earlier', () => {
    const finale = episode('finale', 5, 10, {
      PlayedPercentage: 60,
      LastPlayedDate: '2026-08-23T20:00:00Z',
    });
    const nextSeason = episode('s6e1', 6, 1, {
      Played: true,
      LastPlayedDate: '2026-06-01T12:00:00Z',
    });
    assert.equal(isStaleSkippedEpisode(finale, [finale, nextSeason]), false);
  });

  it('marks a skipped ending when a later episode was started more recently', () => {
    const skipped = episode('e5', 1, 5, {
      PlayedPercentage: 70,
      LastPlayedDate: '2026-08-23T18:00:00Z',
    });
    const startedLater = episode('e6', 1, 6, {
      Played: true,
      LastPlayedDate: '2026-08-23T19:00:00Z',
    });
    assert.equal(isStaleSkippedEpisode(skipped, [skipped, startedLater]), true);
  });

  it('does not mark the frontier episode even when it is above 50 percent', () => {
    const frontier = episode('e10', 1, 10, { PlayedPercentage: 65 });
    assert.equal(isStaleSkippedEpisode(frontier, [frontier]), false);
  });

  it('still treats a played leftover resume point as stale', () => {
    const leftover = episode('e1', 1, 1, {
      Played: true,
      PlayedPercentage: 88,
      LastPlayedDate: '2026-08-25T14:42:00Z',
    });
    const later = episode('e2', 1, 2, { PlaybackPositionTicks: 1 });
    assert.equal(isStaleSkippedEpisode(leftover, [leftover, later]), true);
  });

  it('picks the leading in-progress episode as the frontier', () => {
    const e10 = episode('e10', 1, 10, { PlayedPercentage: 70 });
    const e12 = episode('e12', 1, 12, { PlayedPercentage: 65 });
    const e13 = episode('e13', 1, 13, { PlayedPercentage: 60 });
    const e15 = episode('e15', 1, 15, { PlayedPercentage: 55 });
    const e16 = episode('e16', 1, 16, { PlaybackPositionTicks: 1 });
    assert.equal(frontierEpisodeId([e10, e12, e13, e15]), 'e15');
    assert.equal(frontierEpisodeId([e10, e12, e13, e15, e16]), 'e16');
  });
});
