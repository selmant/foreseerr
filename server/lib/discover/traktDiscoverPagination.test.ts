import type { TraktMediaItem } from '@server/api/trakt/interfaces';
import {
  fetchPaginatedTraktDiscoverWithPostFilters,
  needsTraktDiscoverPostFilters,
} from '@server/lib/discover/traktDiscoverPagination';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const item = (id: number): TraktMediaItem => ({
  tmdbId: id,
  mediaType: 'movie',
  title: `Movie ${id}`,
  traktCommunityRating: id >= 3 ? 8 : 4,
});

describe('fetchPaginatedTraktDiscoverWithPostFilters', () => {
  it('fills sparse pages after rating filters', async () => {
    const page = await fetchPaginatedTraktDiscoverWithPostFilters(
      async (upstreamPage) => ({
        items:
          upstreamPage === 1
            ? [item(1), item(2)]
            : upstreamPage === 2
              ? [item(3), item(4)]
              : [],
        hasMore: upstreamPage < 2,
      }),
      {
        page: 1,
        itemsPerPage: 2,
        tmdb: {} as never,
        query: { traktRatingGte: '7' },
        user: undefined,
      }
    );

    assert.equal(page.items.length, 2);
    assert.deepEqual(
      page.items.map((entry) => entry.tmdbId),
      [3, 4]
    );
    assert.equal(page.hasMore, false);
  });

  it('returns an empty terminal page when filters remove everything', async () => {
    const page = await fetchPaginatedTraktDiscoverWithPostFilters(
      async () => ({
        items: [item(1), item(2)],
        hasMore: false,
      }),
      {
        page: 1,
        itemsPerPage: 2,
        tmdb: {} as never,
        query: { traktRatingGte: '9' },
        user: undefined,
      }
    );

    assert.equal(page.items.length, 0);
    assert.equal(page.hasMore, false);
  });

  it('propagates upstream provider failures', async () => {
    await assert.rejects(
      fetchPaginatedTraktDiscoverWithPostFilters(
        async () => {
          throw new Error('Trakt unavailable');
        },
        {
          page: 1,
          itemsPerPage: 2,
          tmdb: {} as never,
          query: { traktRatingGte: '7' },
          user: undefined,
        }
      ),
      /Trakt unavailable/
    );
  });
});

describe('needsTraktDiscoverPostFilters', () => {
  it('detects browse and watched filters', () => {
    assert.equal(needsTraktDiscoverPostFilters(undefined, {}), false);
    assert.equal(
      needsTraktDiscoverPostFilters(undefined, { genre: '28' }),
      true
    );
    assert.equal(
      needsTraktDiscoverPostFilters(
        { id: 1 } as never,
        { ignoreWatched: 'true' },
        false
      ),
      true
    );
    assert.equal(
      needsTraktDiscoverPostFilters(
        { id: 1 } as never,
        { ignoreWatched: 'true' },
        true
      ),
      false
    );
  });
});

describe('fetchPaginatedTraktDiscoverWithPostFilters + sort', () => {
  it('requests each upstream page once while sorting locally', async () => {
    const requestedPages: number[] = [];
    const page = await fetchPaginatedTraktDiscoverWithPostFilters(
      async (upstreamPage) => {
        requestedPages.push(upstreamPage);
        return {
          items: [item(upstreamPage), item(upstreamPage + 10)],
          hasMore: upstreamPage < 3,
        };
      },
      {
        page: 1,
        itemsPerPage: 2,
        tmdb: {} as never,
        query: { traktRatingGte: '0' },
        user: undefined,
        sortBy: 'added',
      }
    );

    assert.deepEqual(requestedPages, [1, 2, 3]);
    assert.equal(page.items.length, 2);
  });
});
