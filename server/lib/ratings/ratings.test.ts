import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mapMdblistToRatingResponse } from './index';

describe('mapMdblistToRatingResponse', () => {
  it('maps MDBList fields onto RatingResponse', () => {
    const mapped = mapMdblistToRatingResponse(
      {
        imdbId: 'tt0944947',
        imdbRating: 9.2,
        imdbVotes: 100,
        rtRating: 89,
        rtUserRating: 85,
        metacriticRating: 86,
        traktRating: 8.8,
        traktVotes: 50,
      },
      { title: 'Game of Thrones', year: 2011 }
    );

    assert.equal(mapped.provider, 'mdblist');
    assert.equal(mapped.rt?.criticsScore, 89);
    assert.equal(mapped.rt?.criticsRating, 'Certified Fresh');
    assert.equal(mapped.rt?.audienceScore, 85);
    assert.equal(mapped.imdb?.criticsScore, 9.2);
    assert.equal(mapped.imdb?.url, 'https://www.imdb.com/title/tt0944947');
    assert.equal(mapped.metacritic?.score, 86);
    assert.equal(mapped.trakt?.rating, 8.8);
  });

  it('supports audience-only RT data', () => {
    const mapped = mapMdblistToRatingResponse(
      { rtUserRating: 72 },
      { title: 'Some Show', year: 2020 }
    );
    assert.equal(mapped.rt?.audienceScore, 72);
    assert.equal(mapped.rt?.criticsScore, undefined);
  });
});
