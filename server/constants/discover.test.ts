import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DiscoverSliderType } from './discover';

describe('DiscoverSliderType ids', () => {
  it('starts Foreseer types at 1001', () => {
    assert.equal(DiscoverSliderType.TMDB_TV_STREAMING_SERVICES, 21);
    assert.equal(DiscoverSliderType.TRAKT_RECOMMENDATIONS, 1001);
    assert.equal(DiscoverSliderType.TRAKT_WATCHLIST, 1002);
    assert.equal(DiscoverSliderType.SIMKL_DROPPED, 1026);
  });
});
