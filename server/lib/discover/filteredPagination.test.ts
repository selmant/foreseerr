import {
  needsDiscoverPostFilters,
  paginateTmdbDiscover,
} from '@server/lib/discover/filteredPagination';
import type { MovieResult } from '@server/models/Search';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const makeMovie = (id: number, voteAverage = 7): MovieResult =>
  ({
    id,
    mediaType: 'movie',
    voteAverage,
    voteCount: 100,
    genreIds: [28],
    originalLanguage: 'en',
    releaseDate: '2020-01-01',
    title: `Movie ${id}`,
  }) as MovieResult;

describe('paginateTmdbDiscover', () => {
  it('returns exact TMDB totals when no post-filters are active', async () => {
    const page = await paginateTmdbDiscover({
      page: 1,
      user: undefined,
      query: {},
      fetchMappedPage: async () => ({
        items: [makeMovie(1), makeMovie(2)],
        totalPages: 5,
        totalResults: 100,
      }),
    });

    assert.equal(page.totalPages, 5);
    assert.equal(page.totalResults, 100);
    assert.equal(page.hasMore, undefined);
    assert.equal(page.results.length, 2);
  });

  it('fills sparse pages after client filters and reports hasMore', async () => {
    const page = await paginateTmdbDiscover({
      page: 1,
      itemsPerPage: 2,
      user: undefined,
      query: { voteAverageGte: '8' },
      fetchMappedPage: async (upstreamPage) => {
        if (upstreamPage === 1) {
          return {
            items: [makeMovie(1, 5), makeMovie(2, 9)],
            totalPages: 4,
            totalResults: 80,
          };
        }
        if (upstreamPage === 2) {
          return {
            items: [makeMovie(3, 8.5), makeMovie(4, 8.1)],
            totalPages: 4,
            totalResults: 80,
          };
        }
        return {
          items: [makeMovie(5, 9), makeMovie(6, 4)],
          totalPages: 4,
          totalResults: 80,
        };
      },
    });

    assert.equal(page.results.length, 2);
    assert.deepEqual(
      page.results.map((item) => item.id),
      [2, 3]
    );
    assert.equal(page.hasMore, true);
    assert.equal(page.totalPages, undefined);
    assert.equal(page.totalResults, undefined);
  });

  it('returns an empty page with hasMore=false at end of results', async () => {
    const page = await paginateTmdbDiscover({
      page: 2,
      itemsPerPage: 2,
      user: undefined,
      query: { voteAverageGte: '8' },
      fetchMappedPage: async () => ({
        items: [makeMovie(1, 5)],
        totalPages: 1,
        totalResults: 1,
      }),
    });

    assert.equal(page.results.length, 0);
    assert.equal(page.hasMore, false);
  });

  it('degrades safely when upstream provider fetch fails', async () => {
    await assert.rejects(
      paginateTmdbDiscover({
        page: 1,
        user: undefined,
        query: { voteAverageGte: '8' },
        fetchMappedPage: async () => {
          throw new Error('TMDB unavailable');
        },
      }),
      /TMDB unavailable/
    );
  });
});

describe('needsDiscoverPostFilters', () => {
  it('detects browse and watched post-filters', () => {
    assert.equal(needsDiscoverPostFilters(undefined, {}), false);
    assert.equal(
      needsDiscoverPostFilters(undefined, { voteAverageGte: '7' }),
      true
    );
    assert.equal(
      needsDiscoverPostFilters({ id: 1 } as never, { ignoreWatched: 'true' }),
      true
    );
  });
});
