import {
  DiscoverSliderType,
  retiredDiscoverSliderTypes,
} from '@server/constants/discover';
import DiscoverSlider from '@server/entity/DiscoverSlider';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import request from 'supertest';
// eslint-disable-next-line no-relative-import-paths/no-relative-import-paths
import { sliderTitles } from '../../../src/components/Discover/constants';
import {
  builtInSliderTitles,
  discoverSliderDefaultTitle,
  discoverSliderEndpoint,
  toDiscoverSliderResponse,
} from './sliderEndpoint';

const T = DiscoverSliderType;

const allTypes = Object.values(DiscoverSliderType).filter(
  (value): value is DiscoverSliderType => typeof value === 'number'
);

/** A representative `data` value for every type that needs one. */
const sampleData: Partial<Record<DiscoverSliderType, string>> = {
  [T.TMDB_MOVIE_KEYWORD]: '180547,9715',
  [T.TMDB_TV_KEYWORD]: '210024',
  [T.TMDB_MOVIE_GENRE]: '28,12',
  [T.TMDB_TV_GENRE]: '16',
  [T.TMDB_SEARCH]: 'star wars & more',
  [T.TMDB_STUDIO]: '420',
  [T.TMDB_NETWORK]: '213',
  [T.TMDB_MOVIE_STREAMING_SERVICES]: 'US,8|337',
  [T.TMDB_TV_STREAMING_SERVICES]: 'GB,8',
  [T.TRAKT_LIST]: 'https://trakt.tv/users/me/lists/my-list?sort=rank,asc',
  [T.ANILIST_LIST]: "Rewatch (2024)! Mom's *",
  [T.MDBLIST_LIST]: 'https://mdblist.com/lists/linaspurinis/top-watched',
};

const expected: Record<DiscoverSliderType, string | undefined> = {
  [T.RECENTLY_ADDED]: undefined,
  [T.RECENT_REQUESTS]: undefined,
  [T.PLEX_WATCHLIST]: undefined,
  [T.TRENDING]: undefined,
  [T.POPULAR_MOVIES]: undefined,
  [T.MOVIE_GENRES]: undefined,
  [T.UPCOMING_MOVIES]: undefined,
  [T.STUDIOS]: undefined,
  [T.POPULAR_TV]: undefined,
  [T.TV_GENRES]: undefined,
  [T.UPCOMING_TV]: undefined,
  [T.NETWORKS]: undefined,
  [T.TMDB_MOVIE_KEYWORD]: '/api/v1/discover/movies?keywords=180547%2C9715',
  [T.TMDB_MOVIE_GENRE]: '/api/v1/discover/movies?genre=28%2C12',
  [T.TMDB_TV_KEYWORD]: '/api/v1/discover/tv?keywords=210024',
  [T.TMDB_TV_GENRE]: '/api/v1/discover/tv?genre=16',
  [T.TMDB_SEARCH]: '/api/v1/search?query=star%20wars%20%26%20more',
  [T.TMDB_STUDIO]: '/api/v1/discover/movies/studio/420',
  [T.TMDB_NETWORK]: '/api/v1/discover/tv/network/213',
  [T.TMDB_MOVIE_STREAMING_SERVICES]:
    '/api/v1/discover/movies?watchRegion=US&watchProviders=8%7C337',
  [T.TMDB_TV_STREAMING_SERVICES]:
    '/api/v1/discover/tv?watchRegion=GB&watchProviders=8',
  [T.TRAKT_RECOMMENDATIONS]:
    '/api/v1/discover/trakt/recommendations?hideUnmapped=true',
  [T.TRAKT_WATCHLIST]: '/api/v1/discover/trakt/watchlist?hideUnmapped=true',
  [T.TRAKT_LIST]:
    '/api/v1/discover/trakt/list?url=https%3A%2F%2Ftrakt.tv%2Fusers%2Fme%2Flists%2Fmy-list%3Fsort%3Drank%2Casc&hideUnmapped=true',
  [T.TRAKT_HISTORY]: '/api/v1/discover/trakt/history?hideUnmapped=true',
  [T.ANILIST_TRENDING]: '/api/v1/discover/anilist/trending?hideUnmapped=true',
  [T.ANILIST_SEASON]: '/api/v1/discover/anilist/season?hideUnmapped=true',
  [T.ANILIST_WATCHING]: '/api/v1/discover/anilist/watching?hideUnmapped=true',
  [T.ANILIST_PLANNING]: '/api/v1/discover/anilist/planning?hideUnmapped=true',
  [T.ANILIST_COMPLETED]: '/api/v1/discover/anilist/completed?hideUnmapped=true',
  [T.ANILIST_LIST]:
    '/api/v1/discover/anilist/list?name=Rewatch%20%282024%29%21%20Mom%27s%20%2A&hideUnmapped=true',
  [T.ANILIST_POPULAR]: '/api/v1/discover/anilist/popular?hideUnmapped=true',
  [T.ANILIST_TOP]: '/api/v1/discover/anilist/top?hideUnmapped=true',
  [T.ANILIST_NEXT_SEASON]:
    '/api/v1/discover/anilist/next-season?hideUnmapped=true',
  [T.MDBLIST_LIST]:
    '/api/v1/discover/mdblist/list?url=https%3A%2F%2Fmdblist.com%2Flists%2Flinaspurinis%2Ftop-watched&hideUnmapped=true',
  [T.SIMKL_TRENDING]: '/api/v1/discover/simkl/trending?hideUnmapped=true',
  [T.SIMKL_PLAN_TO_WATCH]:
    '/api/v1/discover/simkl/library?status=plantowatch&hideUnmapped=true',
  [T.SIMKL_BEST_TV]: undefined,
  [T.SIMKL_BEST_ANIME]: undefined,
  [T.SIMKL_NEW_TV_PREMIERES]: undefined,
  [T.SIMKL_UPCOMING_TV_PREMIERES]: undefined,
  [T.SIMKL_NEW_ANIME_PREMIERES]: undefined,
  [T.SIMKL_UPCOMING_ANIME_PREMIERES]: undefined,
  [T.SIMKL_WATCHING]:
    '/api/v1/discover/simkl/library?status=watching&hideUnmapped=true',
  [T.SIMKL_ON_HOLD]:
    '/api/v1/discover/simkl/library?status=hold&hideUnmapped=true',
  [T.SIMKL_COMPLETED]:
    '/api/v1/discover/simkl/library?status=completed&hideUnmapped=true',
  [T.SIMKL_DROPPED]:
    '/api/v1/discover/simkl/library?status=dropped&hideUnmapped=true',
};

/** Frontend message key for each built-in row that has a fixed name. */
const frontendTitleKey: Partial<
  Record<DiscoverSliderType, keyof typeof sliderTitles>
> = {
  [T.TRAKT_RECOMMENDATIONS]: 'traktrecommendations',
  [T.TRAKT_WATCHLIST]: 'traktwatchlist',
  [T.TRAKT_HISTORY]: 'trakthistory',
  [T.ANILIST_TRENDING]: 'anilisttrending',
  [T.ANILIST_SEASON]: 'anilistseason',
  [T.ANILIST_POPULAR]: 'anilistpopular',
  [T.ANILIST_TOP]: 'anilisttop',
  [T.ANILIST_NEXT_SEASON]: 'anilistnextseason',
  [T.ANILIST_WATCHING]: 'anilistwatching',
  [T.ANILIST_PLANNING]: 'anilistplanning',
  [T.ANILIST_COMPLETED]: 'anilistcompleted',
  [T.SIMKL_TRENDING]: 'simkltrending',
  [T.SIMKL_PLAN_TO_WATCH]: 'simklplantowatch',
  [T.SIMKL_WATCHING]: 'simklwatching',
  [T.SIMKL_ON_HOLD]: 'simklonhold',
  [T.SIMKL_COMPLETED]: 'simklcompleted',
  [T.SIMKL_DROPPED]: 'simkldropped',
};

describe('discoverSliderEndpoint', () => {
  for (const type of allTypes) {
    it(`maps ${DiscoverSliderType[type]} (${type})`, () => {
      assert.equal(
        discoverSliderEndpoint({ type, data: sampleData[type] }),
        expected[type]
      );
    });
  }

  it('never includes page, so the client can append it', () => {
    for (const type of allTypes) {
      const endpoint = discoverSliderEndpoint({
        type,
        data: sampleData[type],
      });
      if (endpoint) assert.doesNotMatch(endpoint, /[?&]page=/);
    }
  });

  it('omits custom rows that are missing the data they need', () => {
    for (const type of Object.keys(sampleData).map(Number)) {
      assert.equal(
        discoverSliderEndpoint({ type, data: undefined }),
        undefined
      );
      assert.equal(discoverSliderEndpoint({ type, data: '  ' }), undefined);
    }
    assert.equal(
      discoverSliderEndpoint({
        type: T.TMDB_MOVIE_STREAMING_SERVICES,
        data: 'US',
      }),
      undefined
    );
    assert.equal(
      discoverSliderEndpoint({
        type: T.TMDB_TV_STREAMING_SERVICES,
        data: ',8',
      }),
      undefined
    );
  });

  it('encodes studio and network path segments', () => {
    assert.equal(
      discoverSliderEndpoint({ type: T.TMDB_STUDIO, data: '1/2' }),
      '/api/v1/discover/movies/studio/1%2F2'
    );
  });

  it('describes every non-retired Foreseerr type', () => {
    for (const type of allTypes) {
      if (type < 1001 || retiredDiscoverSliderTypes.has(type)) continue;
      assert.ok(
        discoverSliderEndpoint({ type, data: sampleData[type] }),
        `${DiscoverSliderType[type]} has no endpoint`
      );
    }
  });
});

describe('discoverSliderDefaultTitle', () => {
  it('matches the frontend slider titles', () => {
    assert.deepEqual(
      Object.keys(builtInSliderTitles).map(Number).sort(),
      Object.keys(frontendTitleKey).map(Number).sort()
    );
    for (const [type, key] of Object.entries(frontendTitleKey)) {
      assert.equal(
        discoverSliderDefaultTitle(Number(type)),
        sliderTitles[key!].defaultMessage,
        DiscoverSliderType[Number(type)]
      );
    }
  });

  it('is absent for stock rows, custom rows, and retired rows', () => {
    for (const type of allTypes) {
      if (frontendTitleKey[type]) continue;
      assert.equal(discoverSliderDefaultTitle(type), undefined);
    }
  });
});

describe('toDiscoverSliderResponse', () => {
  const slider = (init: Partial<DiscoverSlider>) =>
    new DiscoverSlider({
      id: 1,
      order: 0,
      enabled: true,
      isBuiltIn: false,
      ...init,
    });

  it('adds nothing to stock rows', () => {
    const response = toDiscoverSliderResponse(
      slider({ type: T.TRENDING, isBuiltIn: true })
    );
    assert.equal('endpoint' in response, false);
    assert.equal('defaultTitle' in response, false);
  });

  it('adds endpoint and defaultTitle to Foreseerr built-ins', () => {
    const response = toDiscoverSliderResponse(
      slider({ type: T.SIMKL_ON_HOLD, isBuiltIn: true })
    );
    assert.equal(
      response.endpoint,
      '/api/v1/discover/simkl/library?status=hold&hideUnmapped=true'
    );
    assert.equal(response.defaultTitle, 'Simkl On Hold');
    assert.equal(response.type, T.SIMKL_ON_HOLD);
  });

  it('adds only endpoint to admin list rows', () => {
    const response = toDiscoverSliderResponse(
      slider({ type: T.ANILIST_LIST, title: 'Rewatch', data: 'Rewatch' })
    );
    assert.equal(
      response.endpoint,
      '/api/v1/discover/anilist/list?name=Rewatch&hideUnmapped=true'
    );
    assert.equal('defaultTitle' in response, false);
    assert.equal(response.title, 'Rewatch');
  });

  it('returns a plain object, not an entity that could be saved', () => {
    const response = toDiscoverSliderResponse(
      slider({ type: T.TRAKT_WATCHLIST, isBuiltIn: true })
    );
    assert.equal(response instanceof DiscoverSlider, false);
  });
});

describe('slider endpoints against the API spec', () => {
  // The spec rejects undocumented query parameters, so an endpoint that works
  // in the Foreseerr UI can still 400 once a client adds `hideUnmapped`.
  const app = express();
  app.use(
    OpenApiValidator.middleware({
      apiSpec: join(__dirname, '../../../seerr-api.yml'),
      validateRequests: true,
      // Auth is not what this checks; the query parameters are.
      validateSecurity: false,
    })
  );
  app.use((_req, res) => res.status(200).json({ ok: true }));
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => res.status(err.status ?? 500).json({ message: err.message })
  );

  for (const type of allTypes) {
    const endpoint = discoverSliderEndpoint({ type, data: sampleData[type] });
    if (!endpoint) continue;
    it(`accepts ${DiscoverSliderType[type]} with page appended`, async () => {
      const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}page=2`;
      const response = await request(app).get(url);
      assert.equal(response.status, 200, `${url}: ${response.body.message}`);
    });
  }
});
