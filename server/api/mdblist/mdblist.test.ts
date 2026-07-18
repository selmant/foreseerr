import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseMdblistRatings } from './parse';
import type { MdblistMediaPayload } from './types';

/**
 * Real-shaped MDBList payload for Game of Thrones (a series OMDb returns
 * almost no RT/Metacritic data for). `score` is normalised 0–100 for every
 * source regardless of the per-source `value` scale.
 */
const GOT_PAYLOAD: MdblistMediaPayload = {
  title: 'Game of Thrones',
  type: 'show',
  ids: { imdb: 'tt0944947', trakt: 1390, tmdb: 1399, tvdb: 121361 },
  ratings: [
    { source: 'imdb', value: 9.2, score: 92, votes: 2630633 },
    { source: 'metacritic', value: 86, score: 86, votes: 171 },
    { source: 'metacriticuser', value: 8.4, score: 84.0, votes: 20104 },
    { source: 'trakt', value: 88, score: 88, votes: 64214 },
    { source: 'tomatoes', value: 89, score: 89, votes: 337 },
    { source: 'popcorn', value: 85, score: 85, votes: null },
    { source: 'tmdb', value: 84, score: 84, votes: 27165 },
    { source: 'letterboxd', value: null, score: null, votes: null },
  ],
};

describe('parseMdblistRatings', () => {
  it('maps scores to normalized columns', () => {
    const parsed = parseMdblistRatings(GOT_PAYLOAD);
    assert.equal(parsed.imdbId, 'tt0944947');
    assert.equal(parsed.imdbRating, 9.2);
    assert.equal(parsed.imdbVotes, 2630633);
    assert.equal(parsed.rtRating, 89);
    assert.equal(parsed.rtUserRating, 85);
    assert.equal(parsed.metacriticRating, 86);
    assert.equal(parsed.traktRating, 8.8);
    assert.equal(parsed.traktVotes, 64214);
    assert.equal(parsed.tmdbRating, 8.4);
  });

  it('missing sources become undefined', () => {
    const parsed = parseMdblistRatings({ ids: {}, ratings: [] });
    assert.equal(parsed.imdbRating, undefined);
    assert.equal(parsed.rtRating, undefined);
    assert.equal(parsed.rtUserRating, undefined);
    assert.equal(parsed.metacriticRating, undefined);
    assert.equal(parsed.traktRating, undefined);
    assert.equal(parsed.tmdbRating, undefined);
  });
});
