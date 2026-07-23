import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MediaActionAggregate } from './types';
import { classifyWriteOutcome, writeHttpStatus } from './writeOutcome';

function aggregate(
  providers: MediaActionAggregate['providers']
): MediaActionAggregate {
  return {
    tmdbId: 550,
    mediaType: 'movie',
    watched: false,
    rating: null,
    ratingStars: null,
    providers,
  };
}

describe('classifyWriteOutcome', () => {
  it('returns failure when no providers ran', () => {
    assert.equal(classifyWriteOutcome(aggregate([])), 'failure');
    assert.equal(writeHttpStatus('failure'), 502);
  });

  it('returns failure when every provider rejects', () => {
    const result = aggregate([
      {
        provider: 'trakt',
        ok: false,
        watched: false,
        rating: null,
        ratingStars: null,
        error: 'mark failed',
      },
    ]);
    assert.equal(classifyWriteOutcome(result), 'failure');
  });

  it('returns success when every provider succeeds', () => {
    const result = aggregate([
      {
        provider: 'trakt',
        ok: true,
        watched: true,
        rating: null,
        ratingStars: null,
      },
    ]);
    assert.equal(classifyWriteOutcome(result), 'success');
    assert.equal(writeHttpStatus('success'), 200);
  });

  it('returns partial when some providers succeed and some fail', () => {
    const result = aggregate([
      {
        provider: 'trakt',
        ok: true,
        watched: true,
        rating: null,
        ratingStars: null,
      },
      {
        // Cast: only trakt exists today; shape supports future multi-provider.
        provider: 'trakt',
        ok: false,
        watched: false,
        rating: null,
        ratingStars: null,
        error: 'downstream failed',
      },
    ]);
    assert.equal(classifyWriteOutcome(result), 'partial');
    assert.equal(writeHttpStatus('partial'), 207);
  });
});
