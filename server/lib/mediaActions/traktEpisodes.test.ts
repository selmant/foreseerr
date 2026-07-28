import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findWatchedEpisodeNumbers } from './traktEpisodes';

describe('Trakt episode watched-state mapping', () => {
  const watchedShows = [
    {
      show: { ids: { tmdb: 42 } },
      seasons: [
        {
          number: 1,
          episodes: [
            { number: 1, plays: 1 },
            { number: 2, plays: 2 },
            { number: 2, plays: 2 },
            { number: 3, plays: 0 },
          ],
        },
        { number: 2, episodes: [{ number: 1, plays: 1 }] },
      ],
    },
  ];

  it('returns unique watched episode numbers for the requested show season', () => {
    assert.deepEqual(findWatchedEpisodeNumbers(watchedShows, 42, 1), [1, 2]);
  });

  it('does not mix shows or seasons', () => {
    assert.deepEqual(findWatchedEpisodeNumbers(watchedShows, 42, 2), [1]);
    assert.deepEqual(findWatchedEpisodeNumbers(watchedShows, 99, 1), []);
  });
});
