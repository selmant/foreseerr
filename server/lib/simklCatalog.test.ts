import SimklAPI from '@server/api/simkl';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assignWorkingTmdbMediaType,
  catalogWatchlistItems,
  fillMissingTmdbIds,
  isSimklVideoGamePlay,
  paginateWatchlist,
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
    const page = paginateWatchlist(results, 1);
    assert.equal(page.results.length, 20);
    assert.equal(
      page.results.filter((item) => item.tmdbId).length,
      20,
      'slider page should already carry TMDB ids from CDN'
    );
    assert.equal(page.results[0].mediaType, 'tv');
    const movies = catalogWatchlistItems([payload], 'movie', 'simkl-public');
    assert.equal(movies[0].mediaType, 'movie');
    assert.ok(movies[0].tmdbId);
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

  it('fills TMDB ids from GET /movies/{id} when the list payload omitted them', async () => {
    const response = await fetch(
      'https://api.simkl.com/movies/trending?client_id=invalid-test&app-name=foreseerr&app-version=dev',
      { headers: API_HEADERS }
    );
    const payload = await response.json();
    const listed = catalogWatchlistItems([payload], 'movie', 'simkl-public');
    assert.equal(listed[0].tmdbId, undefined);
    const client = new SimklAPI({ clientId: 'invalid-test' });
    const filled = await fillMissingTmdbIds(listed.slice(0, 2), (kind, id) =>
      client.getTitle(kind, id)
    );
    assert.ok(filled[0].tmdbId, 'detail endpoint should supply ids.tmdb');
    assert.equal(filled[0].id, filled[0].tmdbId);
  });

  it('fills TMDB ids from GET /tv/{id} for live TV trending', async () => {
    const response = await fetch(
      'https://api.simkl.com/tv/trending?client_id=invalid-test&app-name=foreseerr&app-version=dev',
      { headers: API_HEADERS }
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    const listed = catalogWatchlistItems([payload], 'tv', 'simkl-public');
    assert.equal(listed[0].tmdbId, undefined);
    assert.equal(listed[0].mediaType, 'tv');
    const client = new SimklAPI({ clientId: 'invalid-test' });
    const filled = await fillMissingTmdbIds(listed.slice(0, 2), (kind, id) => {
      assert.equal(kind, 'tv');
      return client.getTitle(kind, id);
    });
    assert.ok(filled[0].tmdbId);
    const tmdb = await fetch(
      `https://www.themoviedb.org/tv/${filled[0].tmdbId}`
    );
    assert.equal(tmdb.status, 200, 'Simkl tv tmdb id must exist on TMDB');
  });

  it('CDN movie tmdb ids exist on themoviedb.org', async () => {
    const payload = await new SimklAPI({
      clientId: 'invalid-test',
    }).getCdnCatalog('/discover/trending/movies/week_100.json');
    const item = catalogWatchlistItems([payload], 'movie', 'simkl-public')[0];
    assert.ok(item.tmdbId);
    const tmdb = await fetch(`https://www.themoviedb.org/movie/${item.tmdbId}`);
    assert.equal(tmdb.status, 200);
  });

  it('loads live anime detail ids.tmdb', async () => {
    const client = new SimklAPI({ clientId: 'invalid-test' });
    const payload = await client.getCdnCatalog(
      '/discover/trending/anime/week_100.json'
    );
    const item = catalogWatchlistItems([payload], 'anime', 'simkl-public')[0];
    assert.ok(item.sourceId);
    const detail = await client.getTitle('anime', item.sourceId);
    const ids = (detail.ids ?? {}) as Record<string, unknown>;
    const fromDetail = Number(ids.tmdb);
    if (item.tmdbId) {
      assert.equal(fromDetail, item.tmdbId);
    } else {
      assert.ok(fromDetail > 0);
    }
    const tmdb = await fetch(
      `https://www.themoviedb.org/tv/${item.tmdbId ?? fromDetail}`
    );
    assert.equal(tmdb.status, 200);
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

  it('resolves missing TMDB ids via the Simkl anime detail endpoint kind', async () => {
    const items = catalogWatchlistItems(
      [
        [
          {
            title: 'Sousou no Frieren',
            url: '/anime/1990194/sousou-no-frieren',
            ids: { simkl_id: 1990194, slug: 'sousou-no-frieren' },
          },
        ],
      ],
      'anime',
      'simkl-best'
    );
    const filled = await fillMissingTmdbIds(items, async (kind, id) => {
      assert.equal(kind, 'anime');
      assert.equal(id, '1990194');
      return { ids: { tmdb: '209867' } };
    });
    assert.equal(filled[0].tmdbId, 209867);
    assert.equal(filled[0].id, 209867);
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

  it('flips Simkl tv items to movie when only the movie TMDB id works', async () => {
    const items: WatchlistItem[] = [
      {
        id: 378064,
        ratingKey: 'simkl-best-1',
        tmdbId: 378064,
        mediaType: 'tv',
        title: 'A Silent Voice',
        source: 'simkl',
        sourceId: '1',
      },
    ];
    const resolved = await assignWorkingTmdbMediaType(items, async (kind) =>
      kind === 'movie' ? 'A Silent Voice' : false
    );
    assert.equal(resolved[0].mediaType, 'movie');
    assert.equal(resolved[0].tmdbId, 378064);
  });

  it('drops Simkl video-game-play titles from catalog mapping', () => {
    const payload = [
      {
        title: 'Red Dead Redemption II',
        year: 2018,
        url: '/tv/2276947/red-dead-redemption-ii',
        genres: ['Action', 'Video Game Play', 'Western'],
        ids: { simkl_id: 2276947, slug: 'red-dead-redemption-ii' },
      },
    ];
    assert.equal(isSimklVideoGamePlay(payload[0]), true);
    assert.equal(
      catalogWatchlistItems([payload], 'tv', 'simkl-best').length,
      0
    );
  });

  it('drops video-game-play titles when Simkl detail is fetched for TMDB ids', async () => {
    const items = catalogWatchlistItems(
      [
        [
          {
            title: 'Red Dead Redemption II',
            url: '/tv/2276947/red-dead-redemption-ii',
            ids: { simkl_id: 2276947, slug: 'red-dead-redemption-ii' },
          },
        ],
      ],
      'tv',
      'simkl-best'
    );
    assert.equal(items.length, 1);
    const filled = await fillMissingTmdbIds(items, async () => ({
      type: 'show',
      network: 'YouTube',
      genres: ['Action', 'Adventure', 'Comedy', 'Crime', 'Drama'],
      ids: { tmdb: '311986' },
    }));
    assert.equal(filled.length, 0);
  });

  it('drops colliding TMDB movie ids whose titles do not match', async () => {
    const items: WatchlistItem[] = [
      {
        id: 313612,
        ratingKey: 'simkl-best-rdr',
        tmdbId: 313612,
        mediaType: 'tv',
        title: 'Red Dead Redemption II',
        source: 'simkl',
        sourceId: '2276947',
      },
    ];
    const resolved = await assignWorkingTmdbMediaType(items, async (kind) =>
      kind === 'movie' ? 'Sindhu Bhairavi' : false
    );
    assert.equal(resolved[0].tmdbId, undefined);
  });

  it('keeps anime films when Simkl romaji overlaps the TMDB English title', async () => {
    const items: WatchlistItem[] = [
      {
        id: 822653,
        ratingKey: 'simkl-premieres-madoka',
        tmdbId: 822653,
        mediaType: 'movie',
        title: 'Gekijouban Mahou Shoujo Madoka Magica: Walpurgis no Kaiten',
        source: 'simkl',
        sourceId: '1621829',
      },
    ];
    const resolved = await assignWorkingTmdbMediaType(items, async (kind) =>
      kind === 'movie'
        ? 'Puella Magi Madoka Magica the Movie -Walpurgisnacht: Rising-'
        : false
    );
    assert.equal(resolved[0].mediaType, 'movie');
    assert.equal(resolved[0].tmdbId, 822653);
  });

  it('maps Simkl anime_type movie as a movie', () => {
    const payload = [
      {
        title: 'Gekijouban Mahou Shoujo Madoka Magica: Walpurgis no Kaiten',
        anime_type: 'movie',
        url: '/anime/1621829/gekijouban-mahou-shoujo-madoka-magica-walpurgis-no-kaiten',
        ids: { simkl_id: 1621829, slug: 'madoka' },
      },
    ];
    const results = catalogWatchlistItems(
      [payload],
      'anime',
      'simkl-premieres'
    );
    assert.equal(results[0].mediaType, 'movie');
  });
});
