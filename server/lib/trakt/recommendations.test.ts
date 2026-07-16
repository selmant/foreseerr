import {
  paginateTraktRecommendationItems,
  TRAKT_RECOMMENDATIONS_ITEMS_PER_PAGE,
} from '@server/lib/trakt/recommendations';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('paginateTraktRecommendationItems', () => {
  it('slices a locally cached recommendation pool by page', () => {
    const pool = Array.from({ length: 45 }, (_, index) => index);

    const pageOne = paginateTraktRecommendationItems(pool, 1);
    const pageTwo = paginateTraktRecommendationItems(pool, 2);
    const pageThree = paginateTraktRecommendationItems(pool, 3);

    assert.equal(
      pageOne.pageItems.length,
      TRAKT_RECOMMENDATIONS_ITEMS_PER_PAGE
    );
    assert.equal(
      pageTwo.pageItems.length,
      TRAKT_RECOMMENDATIONS_ITEMS_PER_PAGE
    );
    assert.equal(pageThree.pageItems.length, 5);
    assert.equal(pageOne.totalPages, 3);
    assert.equal(pageOne.totalResults, 45);
    assert.equal(pageOne.pageItems[0], 0);
    assert.equal(pageTwo.pageItems[0], 20);
    assert.equal(pageThree.pageItems[0], 40);
  });
});
