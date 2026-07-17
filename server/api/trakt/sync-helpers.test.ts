import TraktAPI from '@server/api/trakt';
import type { TraktListEntry } from '@server/api/trakt/interfaces';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('TraktAPI sync payload helpers', () => {
  const watched: TraktListEntry[] = [
    { movie: { ids: { tmdb: 550 } } },
    { show: { ids: { tmdb: 1399 } } },
  ];
  const ratings: TraktListEntry[] = [
    { movie: { ids: { tmdb: 550 } }, rating: 8 },
  ];

  it('detects watched movies/shows by TMDb id', () => {
    assert.equal(TraktAPI.payloadContainsTmdb(watched, 'movie', 550), true);
    assert.equal(TraktAPI.payloadContainsTmdb(watched, 'movie', 999), false);
    assert.equal(TraktAPI.payloadContainsTmdb(watched, 'show', 1399), true);
  });

  it('finds ratings by TMDb id', () => {
    assert.equal(TraktAPI.findRatingForTmdb(ratings, 'movie', 550), 8);
    assert.equal(TraktAPI.findRatingForTmdb(ratings, 'movie', 999), null);
  });
});
