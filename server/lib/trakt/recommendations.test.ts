import type TheMovieDb from '@server/api/themoviedb';
import type { TraktMediaItem } from '@server/api/trakt/interfaces';
import {
  advanceRecsPoolClassification,
  paginateTraktRecommendationItems,
  TRAKT_RECOMMENDATIONS_ITEMS_PER_PAGE,
  TRAKT_RECS_CLASSIFY_CHUNK,
  type RecsPoolCache,
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

describe('advanceRecsPoolClassification', () => {
  const makeItem = (
    tmdbId: number,
    mediaType: 'movie' | 'tv' = 'tv'
  ): TraktMediaItem => ({
    tmdbId,
    mediaType,
    title: `Title ${tmdbId}`,
  });

  function createTmdbStub(animeIds: Set<number>): TheMovieDb & {
    getCallCount: () => number;
  } {
    let calls = 0;
    return {
      mediaHasAnimeKeyword: async ({
        tmdbId,
      }: {
        mediaType: 'movie' | 'tv';
        tmdbId: number;
      }) => {
        calls += 1;
        return animeIds.has(tmdbId);
      },
      getCallCount: () => calls,
    } as TheMovieDb & { getCallCount: () => number };
  }

  it('skips TMDB classification for movie media type', async () => {
    const tmdb = createTmdbStub(new Set([9001]));
    const pool: RecsPoolCache = {
      raw: [makeItem(9001, 'movie'), makeItem(9002, 'movie')],
      kept: [makeItem(9001, 'movie'), makeItem(9002, 'movie')],
      cursor: 2,
      complete: true,
    };

    await advanceRecsPoolClassification(pool, 'movie', tmdb, 20);
    assert.equal(tmdb.getCallCount(), 0);
    assert.equal(pool.kept.length, 2);
  });

  it('skips TMDB classification for all media type', async () => {
    const tmdb = createTmdbStub(new Set([9001]));
    const pool: RecsPoolCache = {
      raw: [makeItem(9001), makeItem(9002)],
      kept: [makeItem(9001), makeItem(9002)],
      cursor: 2,
      complete: true,
    };

    await advanceRecsPoolClassification(pool, 'all', tmdb, 20);
    assert.equal(tmdb.getCallCount(), 0);
    assert.equal(pool.kept.length, 2);
  });

  it('stops after filling needed kept items without scanning the whole pool', async () => {
    // Unique ids so anime-keyword NodeCache from other tests cannot collide.
    const base = 10_000;
    // First item anime, then many non-anime — need 20 kept ⇒ ~2 classify chunks max
    const raw = [
      makeItem(base),
      ...Array.from({ length: 80 }, (_, i) => makeItem(base + i + 1)),
    ];
    const pool: RecsPoolCache = {
      raw,
      kept: [],
      cursor: 0,
      complete: false,
    };
    const tmdb = createTmdbStub(new Set([base]));

    await advanceRecsPoolClassification(pool, 'tv', tmdb, 20);

    assert.ok(pool.kept.length >= 20);
    assert.ok(
      tmdb.getCallCount() <= TRAKT_RECS_CLASSIFY_CHUNK * 2,
      `expected at most 2 chunks of keyword lookups, got ${tmdb.getCallCount()}`
    );
    assert.equal(pool.complete, false);
    assert.ok(pool.cursor < raw.length);
    assert.ok(!pool.kept.some((item) => item.tmdbId === base));
  });

  it('resumes from cursor on a later page request', async () => {
    const base = 20_000;
    const raw = Array.from({ length: 60 }, (_, i) => makeItem(base + i));
    const pool: RecsPoolCache = {
      raw,
      kept: [],
      cursor: 0,
      complete: false,
    };
    // First 10 anime so we scan past them for 20 kept
    const animeIds = new Set(Array.from({ length: 10 }, (_, i) => base + i));
    const tmdb = createTmdbStub(animeIds);

    await advanceRecsPoolClassification(pool, 'tv', tmdb, 20);
    const cursorAfterPage1 = pool.cursor;
    const keptAfterPage1 = pool.kept.length;
    const callsAfterPage1 = tmdb.getCallCount();

    assert.ok(keptAfterPage1 >= 20);
    assert.ok(cursorAfterPage1 > 0);

    await advanceRecsPoolClassification(pool, 'tv', tmdb, 40);
    assert.ok(pool.kept.length >= 40);
    assert.ok(pool.cursor > cursorAfterPage1);
    assert.ok(tmdb.getCallCount() > callsAfterPage1);
  });

  it('marks complete when raw pool is exhausted', async () => {
    const base = 30_000;
    const raw = [makeItem(base), makeItem(base + 1), makeItem(base + 2)];
    const pool: RecsPoolCache = {
      raw,
      kept: [],
      cursor: 0,
      complete: false,
    };
    const tmdb = createTmdbStub(new Set([base]));

    await advanceRecsPoolClassification(pool, 'tv', tmdb, 100);

    assert.equal(pool.complete, true);
    assert.equal(pool.cursor, 3);
    assert.deepEqual(
      pool.kept.map((i) => i.tmdbId),
      [base + 1, base + 2]
    );
  });

  it('keeps only anime when mediaType is anime', async () => {
    const base = 40_000;
    const raw = [makeItem(base), makeItem(base + 1), makeItem(base + 2)];
    const pool: RecsPoolCache = {
      raw,
      kept: [],
      cursor: 0,
      complete: false,
    };
    const tmdb = createTmdbStub(new Set([base + 1]));

    await advanceRecsPoolClassification(pool, 'anime', tmdb, 10);

    assert.equal(pool.complete, true);
    assert.deepEqual(
      pool.kept.map((i) => i.tmdbId),
      [base + 1]
    );
  });
});
