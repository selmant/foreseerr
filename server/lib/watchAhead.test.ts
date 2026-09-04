import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TvdbEpisodeCatalog } from '@server/api/tvdb/interfaces';
import {
  DEFAULT_WATCH_AHEAD_EPISODE_COUNT,
  optionalWatchAheadEpisodeCount,
  playedTvdbIdsFromJellyfin,
  resolveWatchAheadWindow,
  watchAheadEpisodeCount,
} from './watchAhead';

const catalog: TvdbEpisodeCatalog = {
  tvdbSeriesId: 42,
  episodes: [
    { tvdbId: 10, seasonNumber: 0, episodeNumber: 1, title: 'Special' },
    { tvdbId: 11, seasonNumber: 1, episodeNumber: 1, title: 'Pilot' },
    { tvdbId: 12, seasonNumber: 1, episodeNumber: 2, title: 'Second' },
    { tvdbId: 21, seasonNumber: 2, episodeNumber: 1, title: 'Return' },
    { tvdbId: 22, seasonNumber: 2, episodeNumber: 2, title: 'Finale' },
  ],
};

describe('watchAheadEpisodeCount', () => {
  it('defaults, clamps, and ignores junk', () => {
    assert.equal(
      watchAheadEpisodeCount(undefined),
      DEFAULT_WATCH_AHEAD_EPISODE_COUNT
    );
    assert.equal(watchAheadEpisodeCount('10'), 10);
    assert.equal(watchAheadEpisodeCount(0), 1);
    assert.equal(watchAheadEpisodeCount(80), 50);
    assert.equal(watchAheadEpisodeCount(10.6), 11);
    assert.equal(optionalWatchAheadEpisodeCount(null), undefined);
    assert.equal(optionalWatchAheadEpisodeCount(''), undefined);
    assert.equal(optionalWatchAheadEpisodeCount(20), 20);
  });
});

describe('playedTvdbIdsFromJellyfin', () => {
  it('prefers ProviderIds.Tvdb and falls back to season/episode numbers', () => {
    const played = playedTvdbIdsFromJellyfin(catalog, [
      { tvdbId: '12', played: true },
      { seasonNumber: 2, episodeNumber: 1, played: true },
      { tvdbId: 99, seasonNumber: 1, episodeNumber: 1, played: true },
      { tvdbId: 22, played: false },
    ]);
    assert.deepEqual(
      [...played].sort((a, b) => a - b),
      [11, 12, 21]
    );
  });
});

describe('resolveWatchAheadWindow', () => {
  it('starts from the first episode when nothing is watched', () => {
    const window = resolveWatchAheadWindow({ catalog, count: 2 });
    assert.equal(window.lastWatchedIndex, -1);
    assert.deepEqual(
      window.desired.map((episode) => episode.tvdbId),
      [11, 12]
    );
  });

  it('slides forward from the last played catalog episode', () => {
    const window = resolveWatchAheadWindow({
      catalog,
      count: 10,
      playedTvdbIds: new Set([12]),
    });
    assert.deepEqual(
      window.desired.map((episode) => episode.tvdbId),
      [21, 22]
    );
  });

  it('uses the highest watched index when earlier episodes were skipped', () => {
    const window = resolveWatchAheadWindow({
      catalog,
      count: 2,
      playedTvdbIds: new Set([11, 21]),
    });
    assert.deepEqual(
      window.desired.map((episode) => episode.tvdbId),
      [22]
    );
  });

  it('returns an empty window after the last episode', () => {
    const window = resolveWatchAheadWindow({
      catalog,
      count: 10,
      playedTvdbIds: new Set([22]),
    });
    assert.deepEqual(window.desired, []);
  });

  it('does not exceed N even when more catalog remains', () => {
    const window = resolveWatchAheadWindow({
      catalog,
      count: 1,
      playedTvdbIds: new Set([11]),
    });
    assert.deepEqual(
      window.desired.map((episode) => episode.tvdbId),
      [12]
    );
  });
});
