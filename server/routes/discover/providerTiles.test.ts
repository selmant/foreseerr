import AnilistAPI from '@server/api/anilist';
import MdblistAPI from '@server/api/mdblist';
import SimklAPI from '@server/api/simkl';
import TheMovieDb from '@server/api/themoviedb';
import TraktAPI from '@server/api/trakt';
import { DiscoverSliderType } from '@server/constants/discover';
import type {
  WatchlistItem,
  WatchlistResponse,
} from '@server/interfaces/api/discoverInterfaces';
import anilistIdMapping from '@server/lib/anilist/mapping';
import { discoverSliderEndpoint } from '@server/lib/discover/sliderEndpoint';
import { resetTmdbValidityCache } from '@server/lib/discover/validity';
import { getSettings } from '@server/lib/settings';
import discoverRoutes from '@server/routes/discover';
import { setupTestDb } from '@server/test/db';
import { edge, seedEdges } from '@server/test/mapping';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
  mock,
} from 'node:test';
import request from 'supertest';

/**
 * The slider `endpoint` contract: under `hideUnmapped=true` every tile is a
 * clean Seerr discover item, `id` is the TMDB id and `mediaType` is movie/tv.
 * Clients open tiles by `id` and do not read `tmdbId` or `mappingState`.
 */

setupTestDb();

/** TMDB records that exist; anything else 404s, so it counts as dead. */
const ALIVE: Record<string, Record<string, unknown>> = {
  'movie:603': {
    id: 603,
    title: 'The Matrix',
    poster_path: '/matrix.jpg',
    backdrop_path: '/matrix-bg.jpg',
    release_date: '1999-03-30',
  },
  'movie:777003': {
    id: 777003,
    title: 'Mad Max: Fury Road',
    poster_path: '/madmax.jpg',
    release_date: '2015-05-13',
  },
  'tv:209867': {
    id: 209867,
    name: 'Frieren',
    poster_path: '/frieren.jpg',
    backdrop_path: '/frieren-bg.jpg',
    first_air_date: '2023-09-29',
  },
  'tv:888002': {
    id: 888002,
    name: 'Attack on Titan',
    poster_path: '/aot.jpg',
    first_air_date: '2013-04-07',
  },
};

/** TMDB `/find` answers: Trakt's dead alternate-cut id, recovered through IMDB. */
const FIND: Record<string, { movie_results: { id: number }[] }> = {
  tt0000003: { movie_results: [{ id: 777003 }] },
};

const http404 = () =>
  Object.assign(new Error('404'), { response: { status: 404 } });

const app = express();
app.use(express.json());
app.use(
  '/api',
  OpenApiValidator.middleware({
    apiSpec: join(__dirname, '../../../seerr-api.yml'),
    validateRequests: true,
    validateSecurity: false,
  })
);
app.use('/api/v1/discover', discoverRoutes);
app.use(
  (
    err: { status?: number; message?: string },
    _req: express.Request,
    res: express.Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _next: express.NextFunction
  ) => res.status(err.status ?? 500).json({ message: err.message })
);

const mocks: { mock: { restore: () => void } }[] = [];

before(() => {
  mocks.push(
    mock.method(anilistIdMapping, 'sync', async () => undefined),
    mock.method(
      anilistIdMapping,
      'getFromAnilistId',
      async (anilistId: number) =>
        ({
          1: { tmdbId: 209867, mediaType: 'tv' as const },
          2: { tmdbId: 999001, mediaType: 'tv' as const },
        })[anilistId]
    ),
    mock.method(AnilistAPI.prototype, 'getTrending', async () => ({
      pageInfo: { hasNextPage: false },
      media: [1, 2, 3].map((id) => ({
        id,
        format: 'TV',
        title: { english: `Anime ${id}` },
        startDate: { year: 2023 },
      })),
    })),
    mock.method(TraktAPI.prototype, 'getListMetadata', async () => ({
      name: 'Picks',
    })),
    mock.method(TraktAPI.prototype, 'getListItems', async () => ({
      hasMore: false,
      items: [
        { tmdbId: 603, mediaType: 'movie', title: 'The Matrix', traktId: 1 },
        {
          tmdbId: 999003,
          mediaType: 'movie',
          title: 'Mad Max: Fury Road - Black & Chrome Edition',
          traktId: 3,
          imdbId: 'tt0000003',
        },
        { mediaType: 'movie', title: 'Nobody Knows', traktId: 4 },
      ],
    })),
    mock.method(MdblistAPI.prototype, 'isConfigured', () => true),
    mock.method(MdblistAPI.prototype, 'getListItems', async () => ({
      title: 'Top Watched',
      hasMore: false,
      items: [
        {
          tmdbId: 603,
          mediaType: 'movie',
          title: 'The Matrix',
          imdbId: 'tt0133093',
        },
        // A unified list item: an id, but no media type.
        { tmdbId: 1396, title: 'Breaking Bad', imdbId: 'tt0903747' },
        {
          tmdbId: 999003,
          mediaType: 'movie',
          title: 'Mad Max: Fury Road - Black & Chrome Edition',
          imdbId: 'tt0000003',
        },
        { mediaType: 'movie', title: 'Unknown', imdbId: 'tt0000009' },
      ],
    })),
    mock.method(SimklAPI.prototype, 'getCdnCatalog', async () => [
      {
        title: 'The Matrix',
        type: 'movie',
        ids: { simkl: 11, tmdb: 603, imdb: 'tt0133093' },
      },
      { title: 'Nowhere Show', type: 'show', ids: { simkl: 12 } },
    ]),
    mock.method(SimklAPI.prototype, 'getTitle', async () => ({}))
  );
});

after(() => {
  for (const entry of mocks) entry.mock.restore();
});

beforeEach(async () => {
  // AniList 2's first answer (tv:999001) is dead; the dataset knows better.
  await seedEdges(edge('anilist:2', 'tmdb_show:888002:s1'));

  // Set per test: the test setup resets settings between tests.
  const settings = getSettings();
  settings.anilist = {
    ...settings.anilist,
    clientId: 'anilist-client',
    clientSecret: 'anilist-secret',
  };
  settings.trakt = { clientId: 'trakt-client', clientSecret: 'trakt-secret' };
  settings.simkl = { ...settings.simkl, clientId: 'simkl-client' };

  resetTmdbValidityCache();
  Object.defineProperty(TheMovieDb.prototype, 'get', {
    configurable: true,
    value: async (endpoint: string) => {
      const match = /^\/(movie|tv)\/(\d+)$/.exec(endpoint);
      if (match) {
        const record = ALIVE[`${match[1]}:${match[2]}`];
        if (!record) throw http404();
        return record;
      }
      if (endpoint.startsWith('/find/')) {
        return {
          movie_results: [],
          tv_results: [],
          ...FIND[endpoint.slice('/find/'.length)],
        };
      }
      throw new Error(`Unexpected TMDB endpoint ${endpoint}`);
    },
  });
});

afterEach(() => {
  delete (TheMovieDb.prototype as { get?: unknown }).get;
});

const page = async (endpoint: string): Promise<WatchlistResponse> => {
  const res = await request(app).get(
    `${endpoint}${endpoint.includes('?') ? '&' : '?'}page=1`
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as WatchlistResponse;
};

const assertCleanTiles = (results: WatchlistItem[]) => {
  assert.ok(results.length > 0, 'expected at least one tile');
  for (const tile of results) {
    assert.equal(tile.id, tile.tmdbId, `${tile.ratingKey}: id is not tmdbId`);
    assert.ok(
      tile.mediaType === 'movie' || tile.mediaType === 'tv',
      `${tile.ratingKey}: mediaType ${tile.mediaType}`
    );
  }
};

const endpointFor = (type: DiscoverSliderType, data?: string): string => {
  const endpoint = discoverSliderEndpoint({ type, data });
  assert.ok(endpoint);
  return endpoint;
};

describe('slider endpoints return clean tiles', () => {
  it('AniList, including a repaired id', async () => {
    const body = await page(endpointFor(DiscoverSliderType.ANILIST_TRENDING));
    assertCleanTiles(body.results);
    assert.deepEqual(
      body.results.map((tile) => [tile.sourceId, tile.id, tile.mediaType]),
      [
        ['1', 209867, 'tv'],
        ['2', 888002, 'tv'],
      ]
    );
    const repaired = body.results[1];
    assert.equal(repaired.tmdbId, 888002);
    assert.equal(repaired.posterPath, '/aot.jpg');
    assert.equal(repaired.firstAirDate, '2013-04-07');
    assert.equal(body.results[0].backdropPath, '/frieren-bg.jpg');
    assert.equal(typeof body.hasMore, 'boolean');
  });

  it('Trakt list, including a repaired id', async () => {
    const body = await page(
      endpointFor(
        DiscoverSliderType.TRAKT_LIST,
        'https://trakt.tv/users/someone/lists/picks'
      )
    );
    assertCleanTiles(body.results);
    assert.deepEqual(
      body.results.map((tile) => tile.id),
      [603, 777003]
    );
    assert.equal(body.results[0].releaseDate, '1999-03-30');
  });

  it('MDBList, dropping a tile with no media type', async () => {
    const body = await page(
      endpointFor(
        DiscoverSliderType.MDBLIST_LIST,
        'https://mdblist.com/lists/someone/top-watched'
      )
    );
    assertCleanTiles(body.results);
    assert.deepEqual(
      body.results.map((tile) => tile.id),
      [603, 777003]
    );
  });

  it('Simkl trending', async () => {
    const body = await page(endpointFor(DiscoverSliderType.SIMKL_TRENDING));
    assertCleanTiles(body.results);
    assert.deepEqual(
      body.results.map((tile) => [tile.id, tile.mediaType]),
      [[603, 'movie']]
    );
    assert.equal(body.results[0].backdropPath, '/matrix-bg.jpg');
  });

  it('still returns unmapped tiles when hideUnmapped is off', async () => {
    const body = await page(
      '/api/v1/discover/anilist/trending?hideUnmapped=false'
    );
    assert.equal(body.results.length, 3);
    const unmapped = body.results.find((tile) => tile.sourceId === '3');
    assert.equal(unmapped?.tmdbId, undefined);
    assert.equal(unmapped?.id, 3);
  });
});
