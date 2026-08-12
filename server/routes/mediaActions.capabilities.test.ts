import {
  JELLYFIN_MEDIA_ACTION_CAPABILITIES,
  TRAKT_MEDIA_ACTION_CAPABILITIES,
  getDefaultMediaActionProviders,
  getMediaActionCapabilities,
  type MediaActionProvider,
} from '@server/lib/mediaActions';
import { jellyfinEpisodeActions } from '@server/lib/mediaActions/jellyfin';
import { traktEpisodeActions } from '@server/lib/mediaActions/traktEpisodes';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import mediaActionsRoutes from '@server/routes/mediaActions';
import { setupTestDb } from '@server/test/db';
import cookieParser from 'cookie-parser';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';
import request from 'supertest';

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
  app.use(checkUser);
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/media-actions', mediaActionsRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res.status(err.status || 500).json({ message: err.message });
    }
  );
  return app;
}

const traktAvailableMock = mock.method(
  getDefaultMediaActionProviders()[0],
  'isAvailable',
  async () => true
);
const jellyfinAvailableMock = mock.method(
  getDefaultMediaActionProviders()[1],
  'isAvailable',
  async () => false
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

describe('media-actions capabilities', () => {
  beforeEach(() => {
    traktAvailableMock.mock.mockImplementation(async () => true);
    jellyfinAvailableMock.mock.mockImplementation(async () => false);
    traktEpisodeAvailableMock.mock.mockImplementation(async () => true);
    jellyfinEpisodeAvailableMock.mock.mockImplementation(async () => false);
  });

  it('requires an authenticated user', async () => {
    const res = await request(app).get('/api/v1/media-actions/capabilities');
    assert.equal(res.status, 401);
  });

  it('reports Trakt-only capabilities', async () => {
    const agent = await loginAsAdmin();
    const res = await agent.get('/api/v1/media-actions/capabilities');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.movie, { watched: true, rating: true });
    assert.deepEqual(res.body.tv, { watched: true, rating: true });
    assert.deepEqual(res.body.episode, { watched: true, rating: false });
    assert.equal(res.body.providers.length, 2);
    assert.deepEqual(res.body.providers[0], {
      id: 'trakt',
      linked: true,
      capabilities: TRAKT_MEDIA_ACTION_CAPABILITIES,
    });
    assert.deepEqual(res.body.providers[1], {
      id: 'jellyfin',
      linked: false,
      capabilities: JELLYFIN_MEDIA_ACTION_CAPABILITIES,
    });
  });

  it('reports Jellyfin-only capabilities', async () => {
    traktAvailableMock.mock.mockImplementation(async () => false);
    jellyfinAvailableMock.mock.mockImplementation(async () => true);
    traktEpisodeAvailableMock.mock.mockImplementation(async () => false);
    jellyfinEpisodeAvailableMock.mock.mockImplementation(async () => true);
    const agent = await loginAsAdmin();

    const res = await agent.get('/api/v1/media-actions/capabilities');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.movie, { watched: true, rating: false });
    assert.deepEqual(res.body.tv, { watched: true, rating: false });
    assert.deepEqual(res.body.episode, { watched: true, rating: false });
    assert.equal(res.body.providers[0].linked, false);
    assert.equal(res.body.providers[1].linked, true);
  });

  it('reports both-provider capabilities', async () => {
    jellyfinAvailableMock.mock.mockImplementation(async () => true);
    jellyfinEpisodeAvailableMock.mock.mockImplementation(async () => true);
    const agent = await loginAsAdmin();

    const res = await agent.get('/api/v1/media-actions/capabilities');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.movie, { watched: true, rating: true });
    assert.deepEqual(res.body.episode, { watched: true, rating: false });
    assert.equal(res.body.providers[0].linked, true);
    assert.equal(res.body.providers[1].linked, true);
  });

  it('reports neither-provider capabilities', async () => {
    traktAvailableMock.mock.mockImplementation(async () => false);
    jellyfinAvailableMock.mock.mockImplementation(async () => false);
    traktEpisodeAvailableMock.mock.mockImplementation(async () => false);
    jellyfinEpisodeAvailableMock.mock.mockImplementation(async () => false);
    const agent = await loginAsAdmin();

    const res = await agent.get('/api/v1/media-actions/capabilities');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.movie, { watched: false, rating: false });
    assert.deepEqual(res.body.tv, { watched: false, rating: false });
    assert.deepEqual(res.body.episode, { watched: false, rating: false });
  });
});

describe('getMediaActionCapabilities unit matrix', () => {
  it('derives surface flags from provider capability support', async () => {
    const providers: MediaActionProvider[] = [
      {
        id: 'trakt',
        capabilities: TRAKT_MEDIA_ACTION_CAPABILITIES,
        isAvailable: async () => false,
        getStatus: async () => ({
          watched: false,
          rating: null,
          ratingStars: null,
        }),
        getStatuses: async () => [],
        markWatched: async () => ({
          watched: true,
          rating: null,
          ratingStars: null,
        }),
        unmarkWatched: async () => ({
          watched: false,
          rating: null,
          ratingStars: null,
        }),
        rate: async () => ({ watched: false, rating: 8, ratingStars: 4 }),
      },
      {
        id: 'jellyfin',
        capabilities: JELLYFIN_MEDIA_ACTION_CAPABILITIES,
        isAvailable: async () => true,
        getStatus: async () => ({
          watched: false,
          rating: null,
          ratingStars: null,
        }),
        getStatuses: async () => [],
        markWatched: async () => ({
          watched: true,
          rating: null,
          ratingStars: null,
        }),
        unmarkWatched: async () => ({
          watched: false,
          rating: null,
          ratingStars: null,
        }),
        rate: async () => ({
          watched: false,
          rating: null,
          ratingStars: null,
        }),
      },
    ];

    traktEpisodeAvailableMock.mock.mockImplementation(async () => false);
    jellyfinEpisodeAvailableMock.mock.mockImplementation(async () => true);

    const capabilities = await getMediaActionCapabilities(1, providers);

    assert.deepEqual(capabilities.movie, { watched: true, rating: false });
    assert.deepEqual(capabilities.episode, { watched: true, rating: false });
  });
});
