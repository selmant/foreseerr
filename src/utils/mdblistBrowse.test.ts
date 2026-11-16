import type { WatchlistItem } from '@shared/interfaces/api/discoverInterfaces';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  loadMdblistPages,
  validDateRange,
  viewMdblistItems,
} from './mdblistBrowse';

const movie = (
  id: number,
  releaseDate?: string,
  voteAverage?: number
): WatchlistItem => ({
  id,
  ratingKey: `movie-${id}`,
  title: `Movie ${id}`,
  mediaType: 'movie',
  releaseDate,
  voteAverage,
});
const ids = (items: WatchlistItem[]) => items.map((item) => item.id);

describe('complete custom-list discovery', () => {
  it('keeps source order by default for existing curated lists', () => {
    assert.deepEqual(
      ids(viewMdblistItems([movie(1, '1990-01-01'), movie(2, '2026-01-01')])),
      [1, 2]
    );
  });
  it('sorts across page boundaries without changing the source popularity order', async () => {
    const first = [movie(1, '1990-01-01', 9), movie(2, '2010-03-01', 7)];
    const second = [movie(3, '2026-02-01', 8)];
    const requested: number[] = [];
    const list = await loadMdblistPages(async (page) => {
      requested.push(page);
      return {
        page,
        hasMore: page === 1,
        results: page === 1 ? first : second,
      };
    });
    assert.deepEqual(requested, [1, 2]);
    assert.deepEqual(
      ids(viewMdblistItems(list.results, { sortBy: 'release_date.desc' })),
      [3, 2, 1]
    );
    assert.deepEqual(
      ids(viewMdblistItems(list.results, { sortBy: 'vote_average.desc' })),
      [1, 3, 2]
    );
    assert.deepEqual(
      ids(viewMdblistItems(list.results, { sortBy: 'source' })),
      [1, 2, 3]
    );
    assert.deepEqual(ids(list.results), [1, 2, 3]);
    assert.deepEqual(ids(first), [1, 2]);
  });

  it('sorts by numeric TMDB popularity independently of source order, leaving missing values last', () => {
    const items = [
      { ...movie(1, '2026-01-01'), popularity: 5 },
      { ...movie(2, '2000-01-01'), popularity: 90 },
      movie(3),
    ];
    assert.deepEqual(
      ids(viewMdblistItems(items, { sortBy: 'popularity.desc' })),
      [2, 1, 3]
    );
    assert.deepEqual(
      ids(viewMdblistItems(items, { sortBy: 'source' })),
      [1, 2, 3]
    );
  });

  it('uses inclusive bounds and series premiere years, not movie dates or new seasons', () => {
    const series: WatchlistItem = {
      ...movie(1, '2026-01-01'),
      ratingKey: 'tv-1',
      mediaType: 'tv',
      firstAirDate: '2008-01-20',
    };
    const items = [series, movie(2, '2008-12-31'), movie(3, '2009-01-01')];
    assert.deepEqual(
      ids(
        viewMdblistItems(items, {
          sortBy: 'release_date.desc',
          primaryReleaseDateGte: '2008-01-01',
          primaryReleaseDateLte: '2008-12-31',
          firstAirDateGte: '2008-01-01',
          firstAirDateLte: '2008-12-31',
        })
      ),
      [2, 1]
    );
    assert.deepEqual(
      ids(
        viewMdblistItems(items, {
          firstAirDateGte: '2026-01-01',
          primaryReleaseDateGte: '2026-01-01',
        })
      ),
      []
    );
    assert.deepEqual(
      ids(
        viewMdblistItems(items, {
          primaryReleaseDateLte: '2008-12-31',
          firstAirDateLte: '2008-12-31',
          sortBy: 'source',
        })
      ),
      [1, 2]
    );
  });

  it('keeps unknown dates visible last without a year filter and excludes them within a range', () => {
    const items = [movie(1), movie(2, 'invalid'), movie(3, '2025-01-01')];
    assert.deepEqual(
      ids(viewMdblistItems(items, { sortBy: 'release_date.desc' })),
      [3, 1, 2]
    );
    assert.deepEqual(
      ids(viewMdblistItems(items, { primaryReleaseDateGte: '2020-01-01' })),
      [3]
    );
    assert.deepEqual(
      ids(
        viewMdblistItems([movie(1), movie(2, '2025-01-01', 7)], {
          sortBy: 'vote_average.desc',
        })
      ),
      [2, 1]
    );
  });

  it('rejects invalid and inverted date ranges and accepts reset defaults', () => {
    assert.equal(validDateRange({ primaryReleaseDateGte: '20' }), false);
    assert.equal(
      validDateRange({
        primaryReleaseDateGte: '2026-01-01',
        primaryReleaseDateLte: '2020-12-31',
      }),
      false
    );
    assert.equal(validDateRange({ firstAirDateGte: 'NaN' }), false);
    assert.equal(validDateRange({}), true);
    assert.equal(
      validDateRange({
        primaryReleaseDateGte: '1900-01-01',
        primaryReleaseDateLte: '2026-12-31',
      }),
      true
    );
  });

  it('continues after an unmapped page, deduplicates repeats and keeps movie/TV ID collisions', async () => {
    const item = movie(1, '2020-01-01');
    const pages = [
      { page: 1, hasMore: true, results: [] },
      { page: 2, hasMore: true, results: [item] },
      {
        page: 3,
        hasMore: false,
        results: [item, { ...item, mediaType: 'tv' as const }],
      },
    ];
    const data = await loadMdblistPages(async (page) => pages[page - 1]);
    assert.equal(data.results.length, 2);
  });

  it('fails rather than returning an apparently complete partial ranking on page errors', async () => {
    await assert.rejects(
      loadMdblistPages(async (page) => {
        if (page === 2) throw new Error('Provider unavailable');
        return { page, hasMore: true, results: [movie(1)] };
      }),
      /Provider unavailable/
    );
  });

  it('bounds a provider that never ends instead of silently truncating or looping forever', async () => {
    let calls = 0;
    await assert.rejects(
      loadMdblistPages(async (page) => {
        calls++;
        return { page, hasMore: true, results: [] };
      }),
      /incomplete list/
    );
    assert.equal(calls, 100);
  });
});
