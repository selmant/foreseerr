import {
  getMediaActionDispatcher,
  type MediaActionAggregate,
} from '@server/lib/mediaActions';
import { anilistEpisodeActions } from '@server/lib/mediaActions/anilistEpisodes';
import { jellyfinEpisodeActions } from '@server/lib/mediaActions/jellyfin';
import { traktEpisodeActions } from '@server/lib/mediaActions/traktEpisodes';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import mediaActionsRoutes, {
  STATUS_BATCH_MAX_ITEMS,
} from '@server/routes/mediaActions';
import { setupTestDb } from '@server/test/db';
import cookieParser from 'cookie-parser';
import type { Express } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import session from 'express-session';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, beforeEach, describe, it, mock } from 'node:test';
import request from 'supertest';

const API_SPEC_PATH = join(__dirname, '../../seerr-api.yml');

let app: Express;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use(
    OpenApiValidator.middleware({
      apiSpec: API_SPEC_PATH,
      validateRequests: true,
    })
  );
  app.use(checkUser);
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/media-actions', mediaActionsRoutes);
  app.use(
    (
      err: { status?: number; message?: string; errors?: unknown },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res.status(err.status || 500).json({
        message: err.message,
        errors: err.errors,
      });
    }
  );
  return app;
}

const getStatusesMock = mock.method(
  getMediaActionDispatcher(),
  'getStatuses',
  async (_userId: number, items: { mediaType: string; tmdbId: number }[]) =>
    items.map(
      (item): MediaActionAggregate => ({
        tmdbId: item.tmdbId,
        mediaType: item.mediaType as 'movie',
        watched: false,
        rating: null,
        ratingStars: null,
        providers: [],
        actions: {
          watched: { available: false, reason: 'no_provider' },
          rating: { available: false, reason: 'no_provider' },
        },
      })
    )
);
const getEpisodeStatusMock = mock.method(
  traktEpisodeActions,
  'getSeasonStatus',
  async () => ({ available: true, watchedEpisodeNumbers: [1, 3] })
);
const setEpisodeWatchedMock = mock.method(
  traktEpisodeActions,
  'setWatched',
  async () => true
);
const traktEpisodeAvailableMock = mock.method(
  traktEpisodeActions,
  'isAvailable',
  async () => true
);
const jellyfinEpisodeAvailableMock = mock.method(
  jellyfinEpisodeActions,
  'isAvailable',
  async () => false
);
const jellyfinSetEpisodeWatchedMock = mock.method(
  jellyfinEpisodeActions,
  'setEpisodeWatched',
  async () => false
);
const jellyfinSetItemWatchedMock = mock.method(
  jellyfinEpisodeActions,
  'setItemWatched',
  async () => false
);
const anilistEpisodeAvailableMock = mock.method(
  anilistEpisodeActions,
  'isAvailable',
  async () => false
);
const anilistSetEpisodeWatchedMock = mock.method(
  anilistEpisodeActions,
  'setWatched',
  async () => 'skipped' as const
);
const anilistGetSeasonStatusMock = mock.method(
  anilistEpisodeActions,
  'getSeasonStatus',
  async () => ({ available: false, watchedEpisodeNumbers: [] })
);

before(() => {
  app = createApp();
});

setupTestDb();

async function loginAsAdmin() {
  const agent = request.agent(app);
  const settings = getSettings();
  settings.main.localLogin = true;
  settings.main.applicationUrl = 'http://localhost:5055';

  const res = await agent
    .post('/api/v1/auth/local')
    .send({ email: 'admin@seerr.dev', password: 'test1234' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return agent;
}

describe('media-actions status-batch bounds', () => {
  beforeEach(() => {
    getStatusesMock.mock.resetCalls();
  });

  it('rejects batches larger than the configured cap', async () => {
    const agent = await loginAsAdmin();
    const items = Array.from(
      { length: STATUS_BATCH_MAX_ITEMS + 1 },
      (_, i) => ({
        mediaType: 'movie',
        tmdbId: i + 1,
      })
    );

    const res = await agent
      .post('/api/v1/media-actions/status-batch')
      .send({ items });

    assert.equal(res.status, 400);
    assert.match(res.body.message ?? '', /100/);
    assert.equal(getStatusesMock.mock.calls.length, 0);
  });

  it('deduplicates identical media references before provider work', async () => {
    const agent = await loginAsAdmin();
    const res = await agent.post('/api/v1/media-actions/status-batch').send({
      items: [
        { mediaType: 'movie', tmdbId: 42 },
        { mediaType: 'movie', tmdbId: 42 },
        { mediaType: 'tv', tmdbId: 7 },
      ],
    });

    assert.equal(res.status, 200);
    assert.equal(getStatusesMock.mock.calls.length, 1);
    const passedItems = getStatusesMock.mock.calls[0]?.arguments[1] as {
      mediaType: string;
      tmdbId: number;
    }[];
    assert.deepEqual(passedItems, [
      { mediaType: 'movie', tmdbId: 42 },
      { mediaType: 'tv', tmdbId: 7 },
    ]);
    assert.equal(res.body.results.length, 2);
  });
});

describe('episode media actions', () => {
  beforeEach(() => {
    getEpisodeStatusMock.mock.resetCalls();
    setEpisodeWatchedMock.mock.resetCalls();
    setEpisodeWatchedMock.mock.mockImplementation(async () => true);
    traktEpisodeAvailableMock.mock.mockImplementation(async () => true);
    jellyfinEpisodeAvailableMock.mock.mockImplementation(async () => false);
    jellyfinSetEpisodeWatchedMock.mock.mockImplementation(async () => false);
    jellyfinSetEpisodeWatchedMock.mock.resetCalls();
    jellyfinSetItemWatchedMock.mock.mockImplementation(async () => false);
    jellyfinSetItemWatchedMock.mock.resetCalls();
    anilistEpisodeAvailableMock.mock.mockImplementation(async () => false);
    anilistSetEpisodeWatchedMock.mock.mockImplementation(
      async () => 'skipped' as const
    );
    anilistSetEpisodeWatchedMock.mock.resetCalls();
    anilistGetSeasonStatusMock.mock.mockImplementation(async () => ({
      available: false,
      watchedEpisodeNumbers: [],
    }));
  });

  it('requires an authenticated user', async () => {
    const res = await request(app).get(
      '/api/v1/media-actions/tv/42/seasons/1/episodes/status'
    );

    assert.equal(res.status, 401);
    assert.equal(getEpisodeStatusMock.mock.calls.length, 0);
  });

  it('returns one batched watched-state payload for a season', async () => {
    const agent = await loginAsAdmin();
    const res = await agent.get(
      '/api/v1/media-actions/tv/42/seasons/1/episodes/status'
    );

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      available: true,
      watchedEpisodeNumbers: [1, 3],
    });
    assert.equal(getEpisodeStatusMock.mock.calls.length, 1);
    assert.deepEqual(
      getEpisodeStatusMock.mock.calls[0]?.arguments.slice(1),
      [42, 1]
    );
  });

  it('marks an episode watched using validated show and episode coordinates', async () => {
    const agent = await loginAsAdmin();
    const res = await agent
      .post('/api/v1/media-actions/tv/42/seasons/1/episodes/2/watched')
      .send({});

    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'success');
    assert.equal(res.body.watched, true);
    assert.ok(Array.isArray(res.body.providers));
    assert.equal(res.body.providers[0]?.provider, 'trakt');
    assert.equal(res.body.providers[0]?.ok, true);
    assert.equal(res.body.providers[0]?.watched, true);
    assert.equal(res.body.ok, undefined);
    assert.deepEqual(setEpisodeWatchedMock.mock.calls[0]?.arguments.slice(1), [
      42,
      1,
      2,
      true,
    ]);
  });

  it('rejects a watched POST with no JSON content type', async () => {
    const agent = await loginAsAdmin();
    const res = await agent.post(
      '/api/v1/media-actions/tv/42/seasons/1/episodes/2/watched'
    );

    assert.equal(res.status, 415);
    assert.match(res.body.message ?? '', /unsupported media type/i);
    assert.equal(setEpisodeWatchedMock.mock.calls.length, 0);
  });

  it('succeeds when Jellyfin is the only enabled episode provider', async () => {
    traktEpisodeAvailableMock.mock.mockImplementation(async () => false);
    jellyfinEpisodeAvailableMock.mock.mockImplementation(async () => true);
    jellyfinSetEpisodeWatchedMock.mock.mockImplementation(async () => true);
    const agent = await loginAsAdmin();

    const res = await agent
      .post('/api/v1/media-actions/tv/42/seasons/1/episodes/2/watched')
      .send({});

    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'success');
    assert.deepEqual(res.body.providers, [
      {
        provider: 'jellyfin',
        ok: true,
        watched: true,
        rating: null,
        ratingStars: null,
      },
    ]);
  });

  it('does not treat a missing Jellyfin library episode as a failed provider', async () => {
    jellyfinEpisodeAvailableMock.mock.mockImplementation(async () => true);
    jellyfinSetEpisodeWatchedMock.mock.mockImplementation(
      async () => 'skipped' as const
    );
    const agent = await loginAsAdmin();

    const res = await agent
      .post('/api/v1/media-actions/tv/42/seasons/1/episodes/2/watched')
      .send({});

    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'success');
    assert.deepEqual(
      res.body.providers.map(
        (provider: { provider: string }) => provider.provider
      ),
      ['trakt']
    );
  });

  it('writes AniList episode progress when the show is mapped', async () => {
    anilistEpisodeAvailableMock.mock.mockImplementation(async () => true);
    anilistSetEpisodeWatchedMock.mock.mockImplementation(async () => true);
    const agent = await loginAsAdmin();

    const res = await agent
      .post('/api/v1/media-actions/tv/42/seasons/1/episodes/2/watched')
      .send({});

    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'success');
    assert.deepEqual(
      res.body.providers.map(
        (provider: { provider: string }) => provider.provider
      ),
      ['trakt', 'anilist']
    );
    assert.deepEqual(
      anilistSetEpisodeWatchedMock.mock.calls[0]?.arguments.slice(1),
      [42, 1, 2, true]
    );
  });

  it('skips AniList when the title has no anime mapping', async () => {
    anilistEpisodeAvailableMock.mock.mockImplementation(async () => true);
    anilistSetEpisodeWatchedMock.mock.mockImplementation(
      async () => 'skipped' as const
    );
    const agent = await loginAsAdmin();

    const res = await agent
      .post('/api/v1/media-actions/tv/42/seasons/1/episodes/2/watched')
      .send({});

    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'success');
    assert.deepEqual(
      res.body.providers.map(
        (provider: { provider: string }) => provider.provider
      ),
      ['trakt']
    );
  });

  it('uses a direct Jellyfin episode identity supplied by Library', async () => {
    traktEpisodeAvailableMock.mock.mockImplementation(async () => false);
    jellyfinEpisodeAvailableMock.mock.mockImplementation(async () => true);
    jellyfinSetItemWatchedMock.mock.mockImplementation(async () => true);
    const agent = await loginAsAdmin();

    const res = await agent
      .post('/api/v1/media-actions/tv/42/seasons/1/episodes/2/watched')
      .send({ jellyfinItemId: 'episode-opaque-id' });

    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'success');
    assert.deepEqual(
      jellyfinSetItemWatchedMock.mock.calls[0]?.arguments.slice(1),
      ['episode-opaque-id', true]
    );
    assert.equal(jellyfinSetEpisodeWatchedMock.mock.calls.length, 0);
  });

  it('reports partial success when Trakt rejects but Jellyfin succeeds', async () => {
    jellyfinEpisodeAvailableMock.mock.mockImplementation(async () => true);
    jellyfinSetEpisodeWatchedMock.mock.mockImplementation(async () => true);
    setEpisodeWatchedMock.mock.mockImplementation(async () => {
      throw new Error('Trakt unavailable');
    });
    const agent = await loginAsAdmin();

    const res = await agent
      .post('/api/v1/media-actions/tv/42/seasons/1/episodes/2/watched')
      .send({});

    assert.equal(res.status, 207);
    assert.equal(res.body.outcome, 'partial');
    assert.equal(res.body.providers[0].provider, 'trakt');
    assert.equal(res.body.providers[0].ok, false);
    assert.equal(res.body.providers[1].provider, 'jellyfin');
    assert.equal(res.body.providers[1].ok, true);
  });

  it('rejects malformed and out-of-range episode identifiers', async () => {
    const agent = await loginAsAdmin();
    const pathResult = await agent.get(
      '/api/v1/media-actions/tv/not-a-number/seasons/1/episodes/status'
    );
    const coordinateResult = await agent
      .post(
        "/api/v1/media-actions/tv/42/seasons/1/episodes/1'%20OR%201=1--/watched"
      )
      .send({});

    assert.equal(pathResult.status, 400);
    assert.equal(coordinateResult.status, 400);
    assert.equal(getEpisodeStatusMock.mock.calls.length, 0);
    assert.equal(setEpisodeWatchedMock.mock.calls.length, 0);
  });
});
