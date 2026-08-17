import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TvdbEpisodeCatalog } from '@server/api/tvdb/interfaces';
import {
  parseEpisodeSelection,
  resolveEpisodeSelection,
  withOngoingEpisodeRequestLock,
} from './episodeRequests';

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

describe('TVDB episode selection resolver', () => {
  it('resolves one episode and one quota season', () => {
    const result = resolveEpisodeSelection(
      { type: 'single', episodeTvdbId: 12 },
      catalog,
      false
    );
    assert.deepEqual(
      result.episodes.map((episode) => episode.tvdbId),
      [12]
    );
    assert.equal(result.quotaUnits, 1);
  });

  it('resolves an inclusive cross-season range', () => {
    const result = resolveEpisodeSelection(
      { type: 'range', startEpisodeTvdbId: 12, endEpisodeTvdbId: 21 },
      catalog,
      false
    );
    assert.deepEqual(
      result.episodes.map((episode) => episode.tvdbId),
      [12, 21]
    );
    assert.equal(result.quotaUnits, 2);
  });

  it('resolves an inclusive ongoing selection without specials', () => {
    const result = resolveEpisodeSelection(
      { type: 'after', startEpisodeTvdbId: 12 },
      catalog,
      true
    );
    assert.deepEqual(
      result.episodes.map((episode) => episode.tvdbId),
      [12, 21, 22]
    );
  });

  it('rejects reversed ranges and disabled specials', () => {
    assert.throws(
      () =>
        resolveEpisodeSelection(
          { type: 'range', startEpisodeTvdbId: 22, endEpisodeTvdbId: 11 },
          catalog,
          false
        ),
      /reversed/
    );
    assert.throws(
      () =>
        resolveEpisodeSelection(
          { type: 'single', episodeTvdbId: 10 },
          catalog,
          false
        ),
      /disabled/
    );
  });

  it('rejects coerced, oversized, and extra input fields', () => {
    assert.throws(() =>
      parseEpisodeSelection({ type: 'single', episodeTvdbId: '12' })
    );
    assert.throws(() =>
      parseEpisodeSelection({
        type: 'single',
        episodeTvdbId: 12,
        injected: '<script>alert(1)</script>',
      })
    );
    assert.throws(() =>
      parseEpisodeSelection({
        type: 'after',
        startEpisodeTvdbId: Number.MAX_SAFE_INTEGER,
      })
    );
  });
});

describe('withOngoingEpisodeRequestLock', () => {
  it('runs tasks for the same series one at a time', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withOngoingEpisodeRequestLock(42, false, async () => {
      order.push('first-start');
      await firstGate;
      order.push('first-end');
    });
    const second = withOngoingEpisodeRequestLock(42, false, async () => {
      order.push('second');
    });

    while (!order.includes('first-start')) {
      await Promise.resolve();
    }
    assert.deepEqual(order, ['first-start']);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first-start', 'first-end', 'second']);
  });
});
