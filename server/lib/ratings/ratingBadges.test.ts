// The server test runner includes this shared client utility, but the server
// TypeScript path map intentionally has no @app alias.
import {
  DEFAULT_RATING_BADGE_SETTINGS,
  DEFAULT_RATING_SOURCE_TOGGLES,
} from '@server/constants/ratingBadges';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
/* eslint-disable-next-line no-relative-import-paths/no-relative-import-paths */
import {
  buildRatingBadges,
  rowCoversIdleRatingBadges,
} from '../../../src/utils/ratingBadges';

describe('buildRatingBadges', () => {
  it('includes zero TMDB scores when present', () => {
    const badges = buildRatingBadges(
      { tmdbRating: 0, ratings: null },
      DEFAULT_RATING_SOURCE_TOGGLES
    );
    assert.equal(
      badges.some((badge) => badge.key === 'tmdb'),
      true
    );
    assert.equal(badges.find((badge) => badge.key === 'tmdb')?.value, '0%');
  });

  it('omits missing and malformed provider payloads', () => {
    const badges = buildRatingBadges(
      {
        tmdbRating: null,
        ratings: {
          rt: { criticsScore: null, criticsRating: 'Fresh' },
          imdb: {},
        } as never,
      },
      DEFAULT_RATING_SOURCE_TOGGLES
    );
    assert.equal(badges.length, 0);
  });

  it('renders the same ordered sources for complete payloads', () => {
    const item = {
      tmdbRating: 7.5,
      ratings: {
        rt: {
          criticsScore: 88,
          criticsRating: 'Fresh' as const,
          audienceScore: 75,
          audienceRating: 'Upright' as const,
          url: 'https://rottentomatoes.com/example',
        },
        imdb: {
          criticsScore: 8.1,
          criticsScoreCount: 1200,
          url: 'https://imdb.com/example',
        },
        metacritic: { score: 72 },
        trakt: { rating: 8.4 },
      },
    } as never;

    const badges = buildRatingBadges(item, DEFAULT_RATING_SOURCE_TOGGLES);
    assert.deepEqual(
      badges.map((badge) => badge.key),
      ['rt', 'rt-user', 'imdb', 'metacritic', 'trakt-community', 'tmdb']
    );
    assert.equal(badges.find((badge) => badge.key === 'imdb')?.value, '8.1');
    assert.equal(
      badges.find((badge) => badge.key === 'trakt-community')?.value,
      '8.4'
    );
  });
});

describe('rowCoversIdleRatingBadges', () => {
  const scored = { tmdbRating: 7.5, ratings: undefined };
  const looked = { tmdbRating: 7.5, ratings: null };

  it('needs the TMDB score while the idle poster shows it', () => {
    assert.equal(rowCoversIdleRatingBadges({ tmdbRating: undefined }), false);
    assert.equal(rowCoversIdleRatingBadges({ tmdbRating: 0 }), true);
    assert.equal(rowCoversIdleRatingBadges(scored), true);
  });

  it('ignores the score once the TMDB badge is off the idle poster', () => {
    assert.equal(
      rowCoversIdleRatingBadges(
        { tmdbRating: undefined },
        { ...DEFAULT_RATING_BADGE_SETTINGS, posterTmdb: false }
      ),
      true
    );
    assert.equal(
      rowCoversIdleRatingBadges(
        { tmdbRating: undefined },
        { ...DEFAULT_RATING_BADGE_SETTINGS, showTmdb: false }
      ),
      true
    );
  });

  it('needs an MDBList lookup only with a key and an idle MDBList badge', () => {
    // No key: the details would not carry MDBList ratings either.
    assert.equal(rowCoversIdleRatingBadges(scored), true);
    // A key and the default IMDb/RT idle badges: an unlooked row is short.
    assert.equal(
      rowCoversIdleRatingBadges(scored, DEFAULT_RATING_BADGE_SETTINGS, true),
      false
    );
    // A lookup that found nothing is still a lookup.
    assert.equal(
      rowCoversIdleRatingBadges(looked, DEFAULT_RATING_BADGE_SETTINGS, true),
      true
    );
    // Every MDBList badge off the idle poster: the row needs no lookup.
    assert.equal(
      rowCoversIdleRatingBadges(
        scored,
        {
          ...DEFAULT_RATING_BADGE_SETTINGS,
          posterImdb: false,
          posterRt: false,
          posterRtUser: false,
          posterMetacritic: false,
          posterTraktCommunity: false,
        },
        true
      ),
      true
    );
  });
});
