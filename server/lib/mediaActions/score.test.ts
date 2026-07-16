import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { providerRatingToStars, ratingStarsToProvider } from './score';

describe('ratingStarsToProvider', () => {
  it('maps half-stars to Trakt 1–10', () => {
    assert.equal(ratingStarsToProvider(0.5), 1);
    assert.equal(ratingStarsToProvider(1), 2);
    assert.equal(ratingStarsToProvider(2.5), 5);
    assert.equal(ratingStarsToProvider(4.5), 9);
    assert.equal(ratingStarsToProvider(5), 10);
  });

  it('rejects out-of-range stars', () => {
    assert.throws(() => ratingStarsToProvider(0), /ratingStars must be/);
    assert.throws(() => ratingStarsToProvider(5.5), /ratingStars must be/);
  });
});

describe('providerRatingToStars', () => {
  it('halves Trakt ratings', () => {
    assert.equal(providerRatingToStars(8), 4);
    assert.equal(providerRatingToStars(null), null);
    assert.equal(providerRatingToStars(undefined), null);
  });
});
