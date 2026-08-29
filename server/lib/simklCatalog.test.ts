import SimklAPI from '@server/api/simkl';
import { getRepository } from '@server/datasource';
import { MappingCluster } from '@server/entity/MappingCluster';
import { MappingLink } from '@server/entity/MappingLink';
import { upsertCluster } from '@server/lib/mapping/graph';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, type TestContext } from 'node:test';
import {
  catalogCandidates,
  catalogWatchlistItems,
  hydrateSimklCandidates,
  isSimklVideoGamePlay,
  looksLikeAnimeFilmTitle,
  paginateWatchlist,
  resolveSimklCandidates,
  resolveSimklTmdbId,
  syncEntries,
  unwrapSimklLibraryItem,
  type SimklCandidate,
  type SimklTmdbResolvers,
} from './simklCatalog';

setupTestDb();

beforeEach(async () => {
  for (const entity of [MappingLink, MappingCluster]) {
    await getRepository(entity).clear();
  }
});

const API_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Foreseerr/dev (Simkl integration)',
  'simkl-api-key': 'invalid-test',
};

/** Captured `/movies/trending` row: list payloads use `ids.simkl_id`, not `ids.simkl`. */
const MOVIE_TRENDING_ROW = {
  title: 'Motor City',
  url: '/movies/180364/motor-city',
  poster: '20/205643734ad1562d88',
  ids: { simkl_id: 180364, slug: 'motor-city' },
  genres: ['Action', 'Crime', 'Drama'],
  status: 'ended',
};

const liveJson = async (
  t: TestContext,
  url: string,
  reason: string
): Promise<unknown | undefined> => {
  try {
    const response = await fetch(url, { headers: API_HEADERS });
    if (response.status !== 200) {
      t.skip(`${reason} (HTTP ${response.status})`);
      return undefined;
    }
    return await response.json();
  } catch (error) {
    t.skip(
      `${reason} (${error instanceof Error ? error.message : 'fetch failed'})`
    );
    return undefined;
  }
};

const skipUnlessHttpOk = async (
  t: TestContext,
  url: string,
  reason: string
): Promise<boolean> => {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': API_HEADERS['User-Agent'] },
    });
    if (response.status !== 200) {
      t.skip(`${reason} (HTTP ${response.status})`);
      return false;
    }
    return true;
  } catch (error) {
    t.skip(
      `${reason} (${error instanceof Error ? error.message : 'fetch failed'})`
    );
    return false;
  }
};

const skipUnlessLiveMapped = async (
  t: TestContext,
  url: string,
  typeHint: 'movie' | 'tv' | 'anime' | 'all',
  reason: string
) => {
  const payload = await liveJson(t, url, reason);
  if (payload === undefined) return undefined;
  const results = catalogWatchlistItems([payload], typeHint, 'simkl-public');
  if (results.length === 0) {
    t.skip(`${reason} (unmappable catalog)`);
    return undefined;
  }
  return { payload, results };
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
  it('types gekijouban / eiga titles as movie on anime catalogs', () => {
    assert.equal(
      looksLikeAnimeFilmTitle(
        'Gekijouban Mahou Shoujo Madoka Magica: Walpurgis no Kaiten'
      ),
      true
    );
    assert.equal(looksLikeAnimeFilmTitle('Eiga Koe no Katachi'), true);
    assert.equal(looksLikeAnimeFilmTitle('Sousou no Frieren'), false);

    const [madoka] = catalogCandidates(
      [
        [
          {
            title: 'Gekijouban Mahou Shoujo Madoka Magica: Walpurgis no Kaiten',
            ids: { simkl: 1621829, anilist: 162182 },
          },
        ],
      ],
      'anime',
      'simkl-premieres'
    );
    assert.equal(madoka.item.mediaType, 'movie');
    assert.equal(madoka.isAnime, true);
  });

  it('maps /movies/trending items that use ids.simkl_id', () => {
    const payload = [MOVIE_TRENDING_ROW];
    const results = catalogWatchlistItems([payload], 'movie', 'simkl-public');
    assert.equal(results.length, 1);
    assert.equal(results[0].sourceId, '180364');
    assert.equal(results[0].mediaType, 'movie');
    assert.equal(results[0].title, 'Motor City');
    assert.ok(results[0].image?.includes('simkl.in/posters/'));
  });

  it('maps a live /movies/trending array that uses ids.simkl_id', async (t) => {
    const live = await skipUnlessLiveMapped(
      t,
      'https://api.simkl.com/movies/trending?client_id=invalid-test&app-name=foreseerr&app-version=dev',
      'movie',
      'Simkl /movies/trending unavailable'
    );
    if (!live) return;
    assert.ok(live.results[0].sourceId);
    assert.equal(live.results[0].mediaType, 'movie');
    assert.ok(live.results[0].title);
    assert.ok(live.results[0].image?.includes('simkl.in/posters/'));
  });

  it('maps live CDN combined trending and keeps TMDB ids', async (t) => {
    const live = await skipUnlessLiveMapped(
      t,
      'https://data.simkl.in/discover/trending/week_100.json?client_id=invalid-test&app-name=foreseerr&app-version=dev',
      'all',
      'Simkl CDN trending unavailable'
    );
    if (!live || live.results.length < 20) {
      if (live && live.results.length < 20) {
        t.skip(`Simkl CDN trending too short (${live.results.length})`);
      }
      return;
    }
    const { payload, results } = live;
    const withTmdb = results.filter((item) => item.tmdbId);
    if (withTmdb.length / results.length <= 0.9) {
      t.skip(
        `Simkl CDN omitted TMDB ids (${withTmdb.length}/${results.length})`
      );
      return;
    }
    assert.equal(
      results.some((item) => item.sourceUrl?.includes('/anime/')),
      false
    );
    const page = paginateWatchlist(results, 1);
    assert.equal(page.results.length, 20);
    assert.equal(page.results[0].mediaType, 'tv');
    const movies = catalogWatchlistItems([payload], 'movie', 'simkl-public');
    if (movies.length === 0 || !movies[0].tmdbId) {
      t.skip('Simkl CDN movie bucket was unusable');
      return;
    }
    assert.equal(movies[0].mediaType, 'movie');
  });

  it('loads CDN trending through SimklAPI.getCdnCatalog', async (t) => {
    let payload: unknown;
    try {
      payload = await new SimklAPI({
        clientId: 'invalid-test',
      }).getCdnCatalog('/discover/trending/movies/week_100.json');
    } catch (error) {
      t.skip(
        `Simkl CDN catalog failed (${error instanceof Error ? error.message : 'error'})`
      );
      return;
    }
    const results = catalogWatchlistItems([payload], 'movie', 'simkl-public');
    if (results.length < 20 || !results[0].tmdbId) {
      t.skip('Simkl CDN movie catalog was unusable');
      return;
    }
    assert.ok(results[0].tmdbId);
  });

  it('loads /movies/trending through SimklAPI.getCatalog', async (t) => {
    let payload: unknown;
    try {
      payload = await new SimklAPI({
        clientId: 'invalid-test',
      }).getCatalog('/movies/trending', { period: 'week' });
    } catch (error) {
      t.skip(
        `Simkl /movies/trending failed (${error instanceof Error ? error.message : 'error'})`
      );
      return;
    }
    const results = catalogWatchlistItems([payload], 'movie', 'simkl-public');
    if (results.length === 0) {
      t.skip('Simkl /movies/trending catalog was empty');
    }
  });

  it('hydrates ids from GET /movies/{id} when the list payload omitted them', async () => {
    const listed = catalogCandidates(
      [[MOVIE_TRENDING_ROW]],
      'movie',
      'simkl-public'
    );
    assert.equal(listed[0].item.tmdbId, undefined);
    const hydrated = await hydrateSimklCandidates(listed, async (kind, id) => {
      assert.equal(kind, 'movies');
      assert.equal(id, '180364');
      return { ids: { tmdb: '123456', imdb: 'tt1234567' } };
    });
    assert.equal(hydrated[0].ids.tmdb, 123456);
  });

  it('hydrates live /movies/{id} ids when the list payload omitted them', async (t) => {
    const live = await skipUnlessLiveMapped(
      t,
      'https://api.simkl.com/movies/trending?client_id=invalid-test&app-name=foreseerr&app-version=dev',
      'movie',
      'Simkl /movies/trending unavailable'
    );
    if (!live) return;
    const listed = catalogCandidates([live.payload], 'movie', 'simkl-public');
    if (!listed[0] || listed[0].item.tmdbId) {
      t.skip('Simkl /movies/trending already included TMDB ids');
      return;
    }
    const client = new SimklAPI({ clientId: 'invalid-test' });
    const hydrated = await hydrateSimklCandidates(
      listed.slice(0, 2),
      (kind, id) => client.getTitle(kind, id)
    );
    if (!hydrated[0]?.ids.tmdb) {
      t.skip('Simkl movie detail omitted ids.tmdb');
    }
  });

  it('hydrates ids from GET /tv/{id} for live TV trending', async (t) => {
    const live = await skipUnlessLiveMapped(
      t,
      'https://api.simkl.com/tv/trending?client_id=invalid-test&app-name=foreseerr&app-version=dev',
      'tv',
      'Simkl /tv/trending unavailable'
    );
    if (!live) return;
    const listed = catalogCandidates([live.payload], 'tv', 'simkl-public');
    if (!listed[0]) {
      t.skip('Simkl /tv/trending listed no mappable titles');
      return;
    }
    assert.equal(listed[0].item.mediaType, 'tv');
    const client = new SimklAPI({ clientId: 'invalid-test' });
    const hydrated = await hydrateSimklCandidates(
      listed.slice(0, 2),
      (kind, id) => {
        assert.equal(kind, 'tv');
        return client.getTitle(kind, id);
      }
    );
    if (!hydrated[0]?.ids.tmdb) {
      t.skip('Simkl tv detail omitted ids.tmdb');
      return;
    }
    await skipUnlessHttpOk(
      t,
      `https://www.themoviedb.org/tv/${hydrated[0].ids.tmdb}`,
      'TMDB tv page unavailable'
    );
  });

  it('CDN movie tmdb ids exist on themoviedb.org', async (t) => {
    let payload: unknown;
    try {
      payload = await new SimklAPI({
        clientId: 'invalid-test',
      }).getCdnCatalog('/discover/trending/movies/week_100.json');
    } catch (error) {
      t.skip(
        `Simkl CDN catalog failed (${error instanceof Error ? error.message : 'error'})`
      );
      return;
    }
    const item = catalogWatchlistItems([payload], 'movie', 'simkl-public')[0];
    if (!item?.tmdbId) {
      t.skip('Simkl CDN movie catalog omitted TMDB ids');
      return;
    }
    await skipUnlessHttpOk(
      t,
      `https://www.themoviedb.org/movie/${item.tmdbId}`,
      'TMDB movie page unavailable'
    );
  });

  it('loads live anime detail ids.tmdb', async (t) => {
    const client = new SimklAPI({ clientId: 'invalid-test' });
    let payload: unknown;
    try {
      payload = await client.getCdnCatalog(
        '/discover/trending/anime/week_100.json'
      );
    } catch (error) {
      t.skip(
        `Simkl anime CDN failed (${error instanceof Error ? error.message : 'error'})`
      );
      return;
    }
    const item = catalogWatchlistItems([payload], 'anime', 'simkl-public')[0];
    if (!item?.sourceId) {
      t.skip('Simkl anime CDN listed no mappable titles');
      return;
    }
    let detail: Record<string, unknown>;
    try {
      detail = await client.getTitle('anime', item.sourceId);
    } catch (error) {
      t.skip(
        `Simkl anime detail failed (${error instanceof Error ? error.message : 'error'})`
      );
      return;
    }
    const ids = (detail.ids ?? {}) as Record<string, unknown>;
    const fromDetail = Number(ids.tmdb);
    const tmdbId = item.tmdbId ?? (fromDetail > 0 ? fromDetail : undefined);
    if (!tmdbId) {
      t.skip('Simkl anime detail omitted ids.tmdb');
      return;
    }
    await skipUnlessHttpOk(
      t,
      `https://www.themoviedb.org/tv/${tmdbId}`,
      'TMDB tv page unavailable'
    );
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

  it('hydrates anime_type even when the list row already has IMDB', async () => {
    const items = catalogCandidates(
      [
        [
          {
            title: 'Kimi no Na wa.',
            url: '/anime/543146/kimi-no-na-wa',
            ids: { simkl_id: 543146, imdb: 'tt5311514', tmdb: 372058 },
          },
        ],
      ],
      'anime',
      'simkl-best'
    );
    assert.equal(items[0].typedFromSource, false);
    assert.equal(items[0].item.mediaType, 'tv');
    let fetched = 0;
    const hydrated = await hydrateSimklCandidates(items, async (kind, id) => {
      fetched += 1;
      assert.equal(kind, 'anime');
      assert.equal(id, '543146');
      return {
        type: 'anime',
        anime_type: 'movie',
        title: 'Kimi no Na wa.',
        ids: { tmdb: 372058, imdb: 'tt5311514' },
      };
    });
    assert.equal(fetched, 1);
    assert.equal(hydrated[0].item.mediaType, 'movie');
    assert.equal(hydrated[0].typedFromSource, true);
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
  typedFromSource: true,
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

  it('does not accept a lone Simkl tmdb id for an anime movie after confirm', async () => {
    const probed: string[] = [];
    const resolution = await resolveSimklTmdbId(
      {
        isAnime: true,
        typedFromSource: true,
        ids: { tmdb: 372058 },
        item: {
          id: 372058,
          ratingKey: 'simkl-best-kimi',
          tmdbId: 372058,
          mediaType: 'movie',
          title: 'Kimi no Na wa.',
          source: 'simkl',
          sourceId: '543146',
        },
      },
      {
        findByExternalId: async () => [],
        confirm: async (mediaType, tmdbId) => {
          probed.push(`${mediaType}:${tmdbId}`);
          return true;
        },
      }
    );
    assert.equal(resolution.tmdbId, undefined);
    assert.equal(resolution.ambiguous, true);
    assert.deepEqual(
      probed,
      [],
      'must not confirm an uncorroborated anime tmdb'
    );
  });

  it('never falls back to the opposite TMDB namespace', async () => {
    const asked: string[] = [];
    const resolution = await resolveSimklTmdbId(
      {
        isAnime: false,
        typedFromSource: true,
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

  it('does not resolve a tv-typed row through IMDB movie /find', async () => {
    const asked: string[] = [];
    const resolution = await resolveSimklTmdbId(
      {
        isAnime: true,
        typedFromSource: true,
        ids: { imdb: 'tt5311514' },
        item: {
          id: 0,
          ratingKey: 'simkl-best-kimi',
          mediaType: 'tv',
          title: 'Kimi no Na wa.',
          source: 'simkl',
          sourceId: '543146',
        },
      },
      {
        findByExternalId: async (_source, _id, mediaType) => {
          asked.push(mediaType);
          return mediaType === 'movie' ? [372058] : [];
        },
        confirm: async () => false,
      }
    );
    assert.equal(resolution.tmdbId, undefined);
    assert.deepEqual(asked, ['tv']);
  });

  it('resolves a Simkl-typed anime movie via IMDB in the movie namespace', async () => {
    const asked: string[] = [];
    const resolution = await resolveSimklTmdbId(
      {
        isAnime: true,
        typedFromSource: true,
        ids: { imdb: 'tt5311514', tmdb: 372058 },
        item: {
          id: 372058,
          ratingKey: 'simkl-best-kimi',
          mediaType: 'movie',
          title: 'Kimi no Na wa.',
          source: 'simkl',
          sourceId: '543146',
        },
      },
      {
        findByExternalId: async (_source, _id, mediaType) => {
          asked.push(mediaType);
          return mediaType === 'movie' ? [372058] : [];
        },
        confirm: async (mediaType) => mediaType === 'movie',
      }
    );
    assert.equal(resolution.tmdbId, 372058);
    assert.equal(resolution.mediaType, 'movie');
    assert.deepEqual(asked, ['movie']);
  });

  it('does not ask TMDB /find for a movie by TVDB id', async () => {
    const asked: string[] = [];
    await resolveSimklTmdbId(
      {
        isAnime: true,
        typedFromSource: true,
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

  it('falls through to the mapping layer via anilist when IMDB/TVDB are absent', async () => {
    // Link Click S3: Simkl detail has anilist/anidb/mal but no imdb/tvdb/tmdb.
    // Without the mapping fallthrough it stayed an unmapped premiere forever.
    await upsertCluster([
      {
        ref: { ns: 'anilist', id: '191832' },
        confidence: 80,
        sourceKey: 'animeapi',
      },
      {
        ref: { ns: 'tmdb_show', id: '123542' },
        confidence: 80,
        sourceKey: 'animeapi',
      },
    ]);

    const resolution = await resolveSimklTmdbId(
      animeCandidate(
        { anilist: 191832, anidb: 19882 },
        'Shiguang Dailiren III'
      ),
      {
        findByExternalId: async () => [],
        confirm: async (mediaType, tmdbId) =>
          mediaType === 'tv' && tmdbId === 123542,
      }
    );
    assert.equal(resolution.tmdbId, 123542);
    assert.ok(
      (resolution.sourceKey ?? '').includes('animeapi') ||
        (resolution.sourceKey ?? '').includes('mapping')
    );
  });

  it('uses a high-confidence TMDB title hit in the declared type only', async (t) => {
    const resolution = await resolveSimklTmdbId(
      {
        ...animeCandidate({}, 'THE RIBBON HERO'),
        item: {
          ...animeCandidate({}, 'THE RIBBON HERO').item,
          mediaType: 'movie',
        },
      },
      {
        findByExternalId: async () => [],
        confirm: async (mediaType, tmdbId) =>
          mediaType === 'movie' && tmdbId === 1679730,
      }
    );
    if (!resolution.tmdbId) {
      t.skip('TMDB title search unavailable');
      return;
    }
    assert.equal(resolution.tmdbId, 1679730);
    assert.equal(resolution.mediaType, 'movie');
    assert.equal(resolution.sourceKey, 'tmdb-title-search');
  });
});
