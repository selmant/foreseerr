import type { JellyfinLibraryItemExtended } from '@server/api/jellyfin';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  episodeProgress,
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
    const laterWatched = episode('e2', 1, 2, { Played: true });
    assert.equal(
      isStaleSkippedEpisode(episode('e1', 1, 1, { PlayedPercentage: 49 }), [
        laterWatched,
      ]),
      false
    );
    assert.equal(
      isStaleSkippedEpisode(episode('e1', 1, 1, { PlayedPercentage: 50 }), [
        laterWatched,
      ]),
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
});
