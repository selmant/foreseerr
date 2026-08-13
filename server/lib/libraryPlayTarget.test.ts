import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  filterPlayableLibraryTitles,
  resolveSeriesPlayTarget,
  type PlayTargetEpisode,
} from './libraryPlayTarget';

const ep = (
  partial: Partial<PlayTargetEpisode> & {
    Id: string;
    SeriesId: string;
  }
): PlayTargetEpisode => ({
  ParentIndexNumber: 1,
  IndexNumber: 1,
  ...partial,
});

describe('resolveSeriesPlayTarget', () => {
  it('prefers an in-progress episode for the series', () => {
    const seriesId = 'series-1';
    const result = resolveSeriesPlayTarget(seriesId, [
      ep({
        Id: 'e1',
        SeriesId: seriesId,
        ParentIndexNumber: 1,
        IndexNumber: 1,
        UserData: { Played: true },
      }),
      ep({
        Id: 'e2',
        SeriesId: seriesId,
        ParentIndexNumber: 1,
        IndexNumber: 2,
        UserData: {
          PlaybackPositionTicks: 1_000_000,
          PlayedPercentage: 40,
          Played: false,
        },
      }),
      ep({
        Id: 'e3',
        SeriesId: seriesId,
        ParentIndexNumber: 1,
        IndexNumber: 3,
      }),
    ]);

    assert.equal(result?.playItemId, 'e2');
    assert.match(result?.subtitle ?? '', /S1E2/);
    assert.equal(result?.progressPercent, 40);
  });

  it('picks the next unwatched episode in order', () => {
    const seriesId = 'series-1';
    const result = resolveSeriesPlayTarget(seriesId, [
      ep({
        Id: 'e1',
        SeriesId: seriesId,
        ParentIndexNumber: 1,
        IndexNumber: 1,
        UserData: { Played: true },
      }),
      ep({
        Id: 'e2',
        SeriesId: seriesId,
        ParentIndexNumber: 1,
        IndexNumber: 2,
        UserData: { Played: true },
      }),
      ep({
        Id: 'e3',
        SeriesId: seriesId,
        ParentIndexNumber: 2,
        IndexNumber: 1,
      }),
    ]);

    assert.equal(result?.playItemId, 'e3');
    assert.match(result?.subtitle ?? '', /S2E1|Up next/);
  });

  it('rewatches the first non-special season episode when all watched', () => {
    const seriesId = 'series-1';
    const result = resolveSeriesPlayTarget(seriesId, [
      ep({
        Id: 'special',
        SeriesId: seriesId,
        ParentIndexNumber: 0,
        IndexNumber: 1,
        UserData: { Played: true },
      }),
      ep({
        Id: 'e1',
        SeriesId: seriesId,
        ParentIndexNumber: 1,
        IndexNumber: 1,
        UserData: { Played: true },
      }),
      ep({
        Id: 'e2',
        SeriesId: seriesId,
        ParentIndexNumber: 1,
        IndexNumber: 2,
        UserData: { Played: true },
      }),
    ]);

    assert.equal(result?.playItemId, 'e1');
    assert.match(result?.subtitle ?? '', /Rewatch/);
  });

  it('returns undefined when there are no episodes', () => {
    assert.equal(resolveSeriesPlayTarget('series-1', []), undefined);
  });
});

describe('filterPlayableLibraryTitles', () => {
  it('keeps movies even without playItemId', () => {
    const movie = {
      mediaType: 'movie' as const,
      jellyfinItemId: 'movie-1',
      title: 'Movie',
    };
    assert.deepEqual(filterPlayableLibraryTitles([movie]), [movie]);
  });

  it('drops series without a resolved episode playItemId', () => {
    const empty = {
      mediaType: 'tv' as const,
      jellyfinItemId: 'series-1',
      title: 'Empty',
    };
    const playable = {
      mediaType: 'tv' as const,
      jellyfinItemId: 'series-2',
      title: 'Playable',
      playItemId: 'episode-1',
    };
    assert.deepEqual(filterPlayableLibraryTitles([empty, playable]), [
      playable,
    ]);
  });
});
