import SimklAPI from '@server/api/simkl';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  catalogCandidates,
  catalogWatchlistItems,
  hydrateSimklCandidates,
  isSimklVideoGamePlay,
  paginateWatchlist,
  resolveSimklCandidates,
  resolveSimklTmdbId,
  syncEntries,
  unwrapSimklLibraryItem,
  type SimklCandidate,
  type SimklTmdbResolvers,
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

  it('hydrates ids from GET /movies/{id} when the list payload omitted them', async () => {
    const response = await fetch(
      'https://api.simkl.com/movies/trending?client_id=invalid-test&app-name=foreseerr&app-version=dev',
      { headers: API_HEADERS }
    );
    const payload = await response.json();
    const listed = catalogCandidates([payload], 'movie', 'simkl-public');
    assert.equal(listed[0].item.tmdbId, undefined);
    const client = new SimklAPI({ clientId: 'invalid-test' });
    const hydrated = await hydrateSimklCandidates(
      listed.slice(0, 2),
      (kind, id) => client.getTitle(kind, id)
    );
    assert.ok(hydrated[0].ids.tmdb, 'detail endpoint should supply ids.tmdb');
  });

  it('hydrates ids from GET /tv/{id} for live TV trending', async () => {
    const response = await fetch(
      'https://api.simkl.com/tv/trending?client_id=invalid-test&app-name=foreseerr&app-version=dev',
      { headers: API_HEADERS }
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    const listed = catalogCandidates([payload], 'tv', 'simkl-public');
    assert.equal(listed[0].item.tmdbId, undefined);
    assert.equal(listed[0].item.mediaType, 'tv');
    const client = new SimklAPI({ clientId: 'invalid-test' });
    const hydrated = await hydrateSimklCandidates(
      listed.slice(0, 2),
      (kind, id) => {
        assert.equal(kind, 'tv');
        return client.getTitle(kind, id);
      }
    );
    assert.ok(hydrated[0].ids.tmdb);
    const tmdb = await fetch(
      `https://www.themoviedb.org/tv/${hydrated[0].ids.tmdb}`
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

  it('hydrates missing ids via the Simkl anime detail endpoint kind', async () => {
    const items = catalogCandidates(
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
    const hydrated = await hydrateSimklCandidates(items, async (kind, id) => {
      assert.equal(kind, 'anime');
      assert.equal(id, '1990194');
      return { ids: { tmdb: '209867', imdb: 'tt22248376' } };
    });
    assert.equal(hydrated[0].ids.tmdb, 209867);
    assert.equal(hydrated[0].ids.imdb, 'tt22248376');
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

  it('drops video-game-play titles when Simkl detail is fetched for ids', async () => {
    const items = catalogCandidates(
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
    const hydrated = await hydrateSimklCandidates(items, async () => ({
      type: 'show',
      network: 'YouTube',
      genres: ['Action', 'Adventure', 'Comedy', 'Crime', 'Drama'],
      ids: { tmdb: '311986' },
    }));
    assert.equal(hydrated.length, 0);
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

/**
 * Simkl returned a wrong `ids.tmdb` for each of these; the old existence probe
 * fell through to `/movie/{same id}`, which exists as an unrelated film 63% of
 * the time, and rendered it as the anime. Verified against production on
 * 2026-08-28.
 */
const FLAGSHIP_CASES = [
  {
    title: 'Shingeki no Kyojin: The Final Season',
    simklTmdb: 313599,
    wrongMovie: 'Artistenblut',
    imdb: 'tt2560140',
    tvdb: 267440,
    correct: 1429,
  },
  {
    title: 'Boku no Hero Academia FINAL SEASON',
    simklTmdb: 308405,
    wrongMovie: 'The Last Armored Train',
    imdb: 'tt5626028',
    tvdb: 305074,
    correct: 65930,
  },
  {
    title: 'Re:Zero kara Hajimeru Isekai Seikatsu 3rd Season',
    simklTmdb: 328061,
    wrongMovie: 'Ariana',
    imdb: 'tt5607616',
    tvdb: 305089,
    correct: 65942,
  },
  {
    title: 'Kimetsu no Yaiba: Yuukaku-hen',
    simklTmdb: 317316,
    wrongMovie: 'Underground Rustlers',
    imdb: 'tt9335498',
    tvdb: 348545,
    correct: 85937,
  },
  {
    title: 'Bleach: Sennen Kessen-hen',
    simklTmdb: 329809,
    wrongMovie: 'Courted',
    imdb: 'tt0434665',
    tvdb: 74796,
    correct: 30984,
  },
  {
    title: 'Jujutsu Kaisen',
    simklTmdb: 277700,
    wrongMovie: 'Tera Jadoo Chal Gayaa',
    imdb: 'tt12343534',
    tvdb: 377543,
    correct: 95479,
  },
] as const;

const animeCandidate = (
  ids: SimklCandidate['ids'],
  title = 'Some Anime'
): SimklCandidate => ({
  isAnime: true,
  ids,
  item: {
    id: 0,
    ratingKey: 'simkl-best-1',
    mediaType: 'tv',
    title,
    source: 'simkl',
    sourceId: '1',
    ...(ids.tmdb ? { tmdbId: ids.tmdb } : {}),
  },
});

describe('simkl TMDB resolution never infers media type', () => {
  for (const flagship of FLAGSHIP_CASES) {
    it(`recovers ${flagship.title} instead of "${flagship.wrongMovie}"`, async () => {
      const probed: string[] = [];
      const resolvers: SimklTmdbResolvers = {
        findByExternalId: async (source, externalId, mediaType) => {
          assert.equal(
            mediaType,
            'tv',
            'find must stay scoped to the declared media type'
          );
          if (source === 'imdb' && externalId === flagship.imdb)
            return [flagship.correct];
          if (source === 'tvdb' && externalId === String(flagship.tvdb))
            return [flagship.correct];
          return [];
        },
        confirm: async (mediaType, tmdbId) => {
          probed.push(`${mediaType}:${tmdbId}`);
          return mediaType === 'movie';
        },
      };
      const resolution = await resolveSimklTmdbId(
        animeCandidate(
          {
            tmdb: flagship.simklTmdb,
            imdb: flagship.imdb,
            tvdb: flagship.tvdb,
          },
          flagship.title
        ),
        resolvers
      );
      assert.equal(resolution.tmdbId, flagship.correct);
      assert.deepEqual(probed, [], 'must not probe the movie namespace');
    });
  }

  it('reports an uncorroborated anime tmdb id as an unmapped ambiguity', async () => {
    const resolution = await resolveSimklTmdbId(
      animeCandidate({ tmdb: 313599 }),
      {
        findByExternalId: async () => [],
        confirm: async () => true,
      }
    );
    assert.equal(resolution.tmdbId, undefined);
    assert.equal(resolution.ambiguous, true);
  });

  it('never falls back to the opposite TMDB namespace', async () => {
    const asked: string[] = [];
    const resolution = await resolveSimklTmdbId(
      {
        isAnime: false,
        ids: { tmdb: 1396 },
        item: {
          id: 1396,
          ratingKey: 'simkl-best-2',
          tmdbId: 1396,
          mediaType: 'tv',
          title: 'Breaking Bad',
          source: 'simkl',
          sourceId: '2',
        },
      },
      {
        findByExternalId: async () => [],
        confirm: async (mediaType, tmdbId) => {
          asked.push(`${mediaType}:${tmdbId}`);
          return false;
        },
      }
    );
    assert.equal(resolution.tmdbId, undefined);
    assert.deepEqual(asked, ['tv:1396']);
  });

  it('does not ask TMDB /find for a movie by TVDB id', async () => {
    const asked: string[] = [];
    await resolveSimklTmdbId(
      {
        isAnime: true,
        ids: { tvdb: 348545 },
        item: {
          id: 0,
          ratingKey: 'simkl-best-3',
          mediaType: 'movie',
          title: 'Some Anime Film',
          source: 'simkl',
          sourceId: '3',
        },
      },
      {
        findByExternalId: async (source) => {
          asked.push(source);
          return [];
        },
        confirm: async () => true,
      }
    );
    assert.deepEqual(asked, [], 'tvdb_id is unsupported for TMDB movies');
  });

  it('raises confidence when Simkl and /find agree, and treats a split as ambiguous', async () => {
    const [agreed, split] = await resolveSimklCandidates(
      [
        animeCandidate({ tmdb: 1429, imdb: 'tt2560140' }, 'AoT'),
        animeCandidate({ imdb: 'tt-split' }, 'Song of the Samurai'),
      ],
      {
        findByExternalId: async (_source, externalId) =>
          externalId === 'tt2560140' ? [1429] : [302162, 320340],
        confirm: async () => true,
      }
    );
    assert.equal(agreed.item.tmdbId, 1429);
    assert.equal(agreed.resolution.confidence, 95);
    assert.equal(split.item.tmdbId, undefined);
    assert.equal(split.resolution.ambiguous, true);
  });
});
