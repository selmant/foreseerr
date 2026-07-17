import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  evaluateRequestEligibility,
  isEligibleForDiscover,
} from './eligibility';
import { DEFAULT_REQUEST_FILTERS } from './types';

const baseMedia = {
  mediaType: 'movie' as const,
  voteAverage: 7.5,
  voteCount: 200,
  releaseYear: 2020,
  genreIds: [28],
  imdbRating: 7.2,
  imdbVotes: 5000,
};

describe('evaluateRequestEligibility (discover)', () => {
  it('allows everything when filters are disabled', () => {
    assert.equal(
      evaluateRequestEligibility({
        settings: DEFAULT_REQUEST_FILTERS,
        media: { ...baseMedia, voteAverage: 1 },
      }),
      null
    );
  });

  it('blocks low TMDB ratings when enabled and threshold set', () => {
    const reason = evaluateRequestEligibility({
      settings: {
        ...DEFAULT_REQUEST_FILTERS,
        enabled: true,
        tmdbThreshold: 8,
      },
      media: baseMedia,
    });
    assert.match(reason ?? '', /TMDB rating/);
  });

  it('does not apply TMDB gate when threshold is null', () => {
    assert.equal(
      evaluateRequestEligibility({
        settings: {
          ...DEFAULT_REQUEST_FILTERS,
          enabled: true,
          tmdbThreshold: null,
          tmdbMinVotes: null,
        },
        media: { ...baseMedia, voteAverage: 1 },
      }),
      null
    );
  });

  it('blocks excluded genres', () => {
    const reason = evaluateRequestEligibility({
      settings: {
        ...DEFAULT_REQUEST_FILTERS,
        enabled: true,
        excludedGenreIds: [27],
      },
      media: { ...baseMedia, genreIds: [27, 28] },
    });
    assert.match(reason ?? '', /excluded genre/);
  });

  it('blocks low Rotten Tomatoes critics scores from MDBList', () => {
    const reason = evaluateRequestEligibility({
      settings: {
        ...DEFAULT_REQUEST_FILTERS,
        enabled: true,
        rtCriticsThreshold: 80,
      },
      media: { ...baseMedia, rtCriticsScore: 55 },
    });
    assert.match(reason ?? '', /Rotten Tomatoes critics/);
  });

  it('blocks low Metacritic and Trakt community scores', () => {
    assert.match(
      evaluateRequestEligibility({
        settings: {
          ...DEFAULT_REQUEST_FILTERS,
          enabled: true,
          metacriticThreshold: 70,
        },
        media: { ...baseMedia, metacriticScore: 40 },
      }) ?? '',
      /Metacritic/
    );
    assert.match(
      evaluateRequestEligibility({
        settings: {
          ...DEFAULT_REQUEST_FILTERS,
          enabled: true,
          traktThreshold: 8,
        },
        media: { ...baseMedia, traktRating: 6.5 },
      }) ?? '',
      /Trakt community/
    );
  });

  it('allows missing RT when includeNoRating is true', () => {
    assert.equal(
      isEligibleForDiscover(
        {
          ...DEFAULT_REQUEST_FILTERS,
          enabled: true,
          rtAudienceThreshold: 70,
          includeNoRating: true,
        },
        { ...baseMedia, rtAudienceScore: null }
      ),
      true
    );
  });
});
