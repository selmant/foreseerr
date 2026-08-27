import SimklAPI from '@server/api/simkl';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  catalogWatchlistItems,
  syncEntries,
  unwrapSimklLibraryItem,
} from './simklCatalog';

const API_HEADERS = {
  'User-Agent': 'Foreseerr/dev (Simkl integration)',
};

const librarySample = {
  shows: [
    {
      added_to_watchlist_at: '2018-02-24T23:55:13Z',
      status: 'plantowatch',
      show: {
        title: 'Charmed',
        poster: '24/24273cee77f9d9f',
        year: 1998,
        ids: {
          simkl: 297,
          slug: 'charmed',
          tmdb: '1981',
        },
      },
    },
  ],
  movies: [
    {
      added_to_watchlist_at: '2018-02-24T23:55:13Z',
      status: 'completed',
      movie: {
        title: 'The Godfather',
        poster: '01/0101poster',
        year: 1972,
        ids: { simkl: 12, slug: 'the-godfather', tmdb: '238' },
      },
    },
  ],
  anime: [
    {
      added_to_watchlist_at: '2026-05-15T00:13:09Z',
      status: 'completed',
      show: {
        title: 'Cowboy Bebop',
        poster: '36/36842f1bceb6b39',
        year: 1998,
        ids: { simkl: 37089, slug: 'cowboy-bebop' },
      },
      anime_type: 'tv',
    },
  ],
};

describe('simkl catalog mapping', () => {
  it('maps a live /movies/trending array that uses ids.simkl_id', async () => {
    const response = await fetch(
      'https://api.simkl.com/movies/trending?client_id=invalid-test&app-name=foreseerr&app-version=dev',
      { headers: API_HEADERS }
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.ok(Array.isArray(payload));
    const results = catalogWatchlistItems([payload], 'movie', 'simkl-public');
    assert.ok(results.length > 0, 'expected mapped trending movies');
    assert.equal(results.length, payload.length);
    assert.ok(results[0].sourceId);
    assert.equal(results[0].mediaType, 'movie');
    assert.ok(results[0].title);
    assert.ok(results[0].image?.includes('simkl.in/posters/'));
  });

  it('maps live CDN combined trending and keeps TMDB ids', async () => {
    const response = await fetch(
      'https://data.simkl.in/discover/trending/week_100.json?client_id=invalid-test&app-name=foreseerr&app-version=dev',
      { headers: API_HEADERS }
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    const results = catalogWatchlistItems([payload], 'all', 'simkl-public');
    assert.ok(
      results.length >= 20,
      `expected a full slider, got ${results.length}`
    );
    const withTmdb = results.filter((item) => item.tmdbId);
    assert.ok(
      withTmdb.length / results.length > 0.9,
      `expected most CDN items to include tmdb, got ${withTmdb.length}/${results.length}`
    );
    assert.equal(
      results.some((item) => item.sourceUrl?.includes('/anime/')),
      false
    );
  });

  it('loads CDN trending through SimklAPI.getCdnCatalog', async () => {
    const payload = await new SimklAPI({
      clientId: 'invalid-test',
    }).getCdnCatalog('/discover/trending/movies/week_100.json');
    const results = catalogWatchlistItems([payload], 'movie', 'simkl-public');
    assert.ok(results.length >= 20);
    assert.ok(results[0].tmdbId);
  });

  it('loads /movies/trending through SimklAPI.getCatalog', async () => {
    const payload = await new SimklAPI({
      clientId: 'invalid-test',
    }).getCatalog('/movies/trending', { period: 'week' });
    const results = catalogWatchlistItems([payload], 'movie', 'simkl-public');
    assert.ok(results.length > 0);
  });

  it('maps documented /tv/best array items with simkl_id', () => {
    const payload = [
      {
        title: 'Sousou no Frieren',
        year: 2023,
        poster: '14/1430387937a6ef6167',
        url: '/anime/1990194/sousou-no-frieren',
        ids: { simkl_id: 1990194, slug: 'sousou-no-frieren' },
      },
    ];
    const results = catalogWatchlistItems([payload], 'anime', 'simkl-best');
    assert.equal(results.length, 1);
    assert.equal(results[0].sourceId, '1990194');
    assert.equal(results[0].title, 'Sousou no Frieren');
    assert.ok(results[0].sourceUrl?.includes('/anime/1990194/'));
  });

  it('unwraps nested show/movie library records from /sync/all-items', () => {
    const entries = syncEntries(librarySample);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].item.title, 'Charmed');
    assert.equal(entries[0].type, 'show');
    assert.deepEqual((entries[0].item.ids as { simkl: number }).simkl, 297);
    assert.equal(entries[1].type, 'movie');
    assert.equal(entries[2].type, 'anime');
    const unwrapped = unwrapSimklLibraryItem(
      librarySample.shows[0] as unknown as Record<string, unknown>
    );
    assert.equal(unwrapped.title, 'Charmed');
    assert.equal(unwrapped.status, 'plantowatch');
  });
});
