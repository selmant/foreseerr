import { filterTraktDiscoverItems } from '@server/lib/requestFilters';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('filterTraktDiscoverItems', () => {
  it('filters Trakt series by TMDB status and runtime', async () => {
    const tmdb = {
      getTvBrowseMetadata: async ({ tvId }: { tvId: number }) => ({
        id: tvId,
        title: `Series ${tvId}`,
        vote_average: 8,
        vote_count: 100,
        original_language: 'en',
        release_date: '2020-01-01',
        genre_ids: [],
        runtime: tvId === 1 ? 45 : 20,
        status: tvId === 1 ? 'Ended' : 'Returning Series',
      }),
    };

    const results = await filterTraktDiscoverItems(
      [
        { tmdbId: 1, mediaType: 'tv', title: 'Ended series' },
        { tmdbId: 2, mediaType: 'tv', title: 'Returning series' },
      ],
      tmdb as never,
      { status: '3', withRuntimeGte: '30' }
    );

    assert.deepEqual(
      results.map((item) => item.tmdbId),
      [1]
    );
  });

  it('treats movie Action as matching TV Action & Adventure', async () => {
    const tmdb = {
      getTvBrowseMetadata: async ({ tvId }: { tvId: number }) => ({
        id: tvId,
        title: `Series ${tvId}`,
        vote_average: 8,
        vote_count: 100,
        original_language: 'en',
        release_date: '2020-01-01',
        genre_ids: tvId === 1 ? [10759] : [18],
        runtime: 45,
        status: 'Returning Series',
      }),
    };

    const results = await filterTraktDiscoverItems(
      [
        { tmdbId: 1, mediaType: 'tv', title: 'Action series' },
        { tmdbId: 2, mediaType: 'tv', title: 'Drama series' },
      ],
      tmdb as never,
      { genre: '28' }
    );

    assert.deepEqual(
      results.map((item) => item.tmdbId),
      [1]
    );
  });

  it('treats movie Fantasy as matching TV Sci-Fi & Fantasy', async () => {
    const tmdb = {
      getTvBrowseMetadata: async ({ tvId }: { tvId: number }) => ({
        id: tvId,
        title: `Series ${tvId}`,
        vote_average: 8,
        vote_count: 100,
        original_language: 'en',
        release_date: '2020-01-01',
        genre_ids: tvId === 1 ? [10765] : [18],
        runtime: 45,
        status: 'Returning Series',
      }),
    };

    const results = await filterTraktDiscoverItems(
      [
        { tmdbId: 1, mediaType: 'tv', title: 'Fantasy series' },
        { tmdbId: 2, mediaType: 'tv', title: 'Drama series' },
      ],
      tmdb as never,
      { genre: '14' }
    );

    assert.deepEqual(
      results.map((item) => item.tmdbId),
      [1]
    );
  });
});
