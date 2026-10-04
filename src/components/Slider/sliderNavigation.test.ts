import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sliderTarget } from './sliderNavigation';

describe('shelf navigation', () => {
  it('advances a resume card on a phone narrower than the card', () => {
    assert.equal(
      sliderTarget({
        scrollLeft: 0,
        scrollWidth: 2700,
        viewportWidth: 278,
        itemWidth: 304,
        direction: 'next',
      }),
      304
    );
  });
  it('stops at the final visible titles rather than scrolling beyond the shelf', () => {
    assert.equal(
      sliderTarget({
        scrollLeft: 1000,
        scrollWidth: 2200,
        viewportWidth: 1000,
        itemWidth: 200,
        direction: 'next',
      }),
      1200
    );
  });
  it('returns a partially visible first card to the beginning', () => {
    assert.equal(
      sliderTarget({
        scrollLeft: 156,
        scrollWidth: 2000,
        viewportWidth: 700,
        itemWidth: 200,
        direction: 'previous',
      }),
      0
    );
  });
  it('keeps navigation in place when the whole shelf fits', () => {
    assert.equal(
      sliderTarget({
        scrollLeft: 0,
        scrollWidth: 400,
        viewportWidth: 700,
        itemWidth: 200,
        direction: 'next',
      }),
      0
    );
  });
});
