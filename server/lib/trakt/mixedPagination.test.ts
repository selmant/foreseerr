import type { TraktMediaItem } from '@server/api/trakt/interfaces';
import {
  mergeAndPaginateTraktItems,
  paginateSortedTraktItems,
} from '@server/lib/trakt/mixedPagination';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function item(
  mediaType: 'movie' | 'tv',
  tmdbId: number,
  sortAt: string,
  title = `${mediaType}-${tmdbId}`
): TraktMediaItem {
  return {
    mediaType,
    tmdbId,
    title,
    traktAddedAt: sortAt,
  };
}

describe('mergeAndPaginateTraktItems', () => {
  it('caps a mixed page at the requested limit (never movie+tv concat size)', () => {
    const movies = Array.from({ length: 20 }, (_, i) =>
      item(
        'movie',
        i + 1,
        new Date(Date.UTC(2026, 0, 1, 12, 40 - i)).toISOString()
      )
    );
    const shows = Array.from({ length: 20 }, (_, i) =>
      item(
        'tv',
        i + 100,
        new Date(Date.UTC(2026, 0, 1, 12, 39 - i, 30)).toISOString()
      )
    );

    const page = mergeAndPaginateTraktItems(movies, shows, {
      page: 1,
      limit: 20,
      movieHasMore: true,
      tvHasMore: true,
    });

    assert.equal(page.items.length, 20);
    assert.equal(page.hasMore, true);
  });

  it('orders mixed media globally by timestamp descending', () => {
    const movies = [
      item('movie', 1, '2026-01-10T00:00:00.000Z', 'm-late'),
      item('movie', 2, '2026-01-08T00:00:00.000Z', 'm-mid'),
      item('movie', 3, '2026-01-05T00:00:00.000Z', 'm-early'),
    ];
    const shows = [
      item('tv', 10, '2026-01-09T00:00:00.000Z', 's-late'),
      item('tv', 11, '2026-01-07T00:00:00.000Z', 's-mid'),
      item('tv', 12, '2026-01-04T00:00:00.000Z', 's-early'),
    ];

    const page = mergeAndPaginateTraktItems(movies, shows, {
      page: 1,
      limit: 6,
      movieHasMore: false,
      tvHasMore: false,
    });

    assert.deepEqual(
      page.items.map((i) => i.title),
      ['m-late', 's-late', 'm-mid', 's-mid', 'm-early', 's-early']
    );
    assert.equal(page.hasMore, false);
  });

  it('dedupes repeated mediaType:tmdbId without breaking chronology', () => {
    const movies = [
      item('movie', 1, '2026-01-10T00:00:00.000Z', 'keep'),
      item('movie', 1, '2026-01-01T00:00:00.000Z', 'dup-older'),
    ];
    const shows = [item('tv', 1, '2026-01-09T00:00:00.000Z', 'show-same-id')];

    const page = mergeAndPaginateTraktItems(movies, shows, {
      page: 1,
      limit: 10,
      movieHasMore: false,
      tvHasMore: false,
    });

    assert.deepEqual(
      page.items.map((i) => `${i.mediaType}:${i.tmdbId}:${i.title}`),
      ['movie:1:keep', 'tv:1:show-same-id']
    );
  });

  it('keeps chronology across page boundaries without skips or duplicates', () => {
    // Interleaved newest→oldest: even ids movies, odd ids shows.
    const movies: TraktMediaItem[] = [];
    const shows: TraktMediaItem[] = [];
    for (let n = 40; n >= 1; n--) {
      const sortAt = new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
      if (n % 2 === 0) {
        movies.push(item('movie', n, sortAt));
      } else {
        shows.push(item('tv', n, sortAt));
      }
    }

    const page1 = mergeAndPaginateTraktItems(movies, shows, {
      page: 1,
      limit: 20,
      movieHasMore: false,
      tvHasMore: false,
    });
    const page2 = mergeAndPaginateTraktItems(movies, shows, {
      page: 2,
      limit: 20,
      movieHasMore: false,
      tvHasMore: false,
    });

    assert.equal(page1.items.length, 20);
    assert.equal(page2.items.length, 20);
    assert.equal(page1.hasMore, true);
    assert.equal(page2.hasMore, false);

    const combined = [...page1.items, ...page2.items];
    const keys = combined.map((i) => `${i.mediaType}:${i.tmdbId}`);
    assert.equal(new Set(keys).size, keys.length, 'no duplicates across pages');

    for (let i = 1; i < combined.length; i++) {
      const prev = Date.parse(combined[i - 1].traktAddedAt || '');
      const cur = Date.parse(combined[i].traktAddedAt || '');
      assert.ok(prev >= cur, `out of order at index ${i}`);
    }

    assert.equal(combined[0].tmdbId, 40);
    assert.equal(combined[19].tmdbId, 21);
    assert.equal(combined[20].tmdbId, 20);
    assert.equal(combined[39].tmdbId, 1);
  });

  it('sets hasMore when either upstream stream may still have items', () => {
    const movies = [item('movie', 1, '2026-01-10T00:00:00.000Z')];
    const shows = [item('tv', 2, '2026-01-09T00:00:00.000Z')];

    const page = mergeAndPaginateTraktItems(movies, shows, {
      page: 1,
      limit: 20,
      movieHasMore: true,
      tvHasMore: false,
    });

    assert.equal(page.items.length, 2);
    assert.equal(page.hasMore, true);
  });
});

describe('paginateSortedTraktItems', () => {
  it('orders globally across three upstream pages, not per-page', () => {
    // Upstream pages are in listed_at order; global added sort must reorder across pages.
    const upstreamPages = [
      [
        item('movie', 1, '2026-01-01T00:00:00.000Z', 'page1-oldest'),
        item('movie', 2, '2026-01-05T00:00:00.000Z', 'page1-mid'),
        item('tv', 3, '2026-01-03T00:00:00.000Z', 'page1-newer'),
      ],
      [
        item('movie', 4, '2026-01-10T00:00:00.000Z', 'page2-newest'),
        item('tv', 5, '2026-01-02T00:00:00.000Z', 'page2-old'),
      ],
      [
        item('tv', 6, '2026-01-08T00:00:00.000Z', 'page3-late'),
        item('movie', 7, '2026-01-04T00:00:00.000Z', 'page3-mid'),
      ],
    ];

    const allItems = upstreamPages.flat();
    const page1 = paginateSortedTraktItems(allItems, {
      page: 1,
      limit: 3,
      sortBy: 'added',
      hasMoreUpstream: false,
    });
    const page2 = paginateSortedTraktItems(allItems, {
      page: 2,
      limit: 3,
      sortBy: 'added',
      hasMoreUpstream: false,
    });

    assert.deepEqual(
      page1.items.map((entry) => entry.title),
      ['page2-newest', 'page3-late', 'page1-mid']
    );
    assert.deepEqual(
      page2.items.map((entry) => entry.title),
      ['page3-mid', 'page1-newer', 'page2-old']
    );
    assert.equal(page1.hasMore, true);
    assert.equal(page2.hasMore, true);

    const page3 = paginateSortedTraktItems(allItems, {
      page: 3,
      limit: 3,
      sortBy: 'added',
      hasMoreUpstream: false,
    });
    assert.deepEqual(
      page3.items.map((entry) => entry.title),
      ['page1-oldest']
    );
    assert.equal(page3.hasMore, false);
  });
});
