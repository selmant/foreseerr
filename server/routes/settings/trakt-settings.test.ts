import JellyfinAPI from '@server/api/jellyfin';
import MdblistAPI from '@server/api/mdblist';
import TraktAPI from '@server/api/trakt';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { clearIntegrationHealthCache } from '@server/lib/integrationHealth';
import {
  clearSyncCache,
  getUserSyncSnapshot,
  seedUserSyncCache,
} from '@server/lib/mediaActions/syncCache';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import settingsRoutes from '@server/routes/settings';
import { setupTestDb } from '@server/test/db';
import axios from 'axios';
import cookieParser from 'cookie-parser';
import type { Express } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import session from 'express-session';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, beforeEach, describe, it, mock } from 'node:test';
import request from 'supertest';

const API_SPEC_PATH = join(__dirname, '../../../seerr-api.yml');

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
  app.use(
    '/api/v1/settings',
    isAuthenticated(Permission.ADMIN),
    settingsRoutes
  );
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

before(async () => {
  app = createApp();
});

setupTestDb();

async function loginAsAdmin() {
  const agent = request.agent(app);
  const settings = getSettings();
  settings.main.localLogin = true;
  settings.main.applicationUrl = 'http://localhost:5055';
  settings.trakt = {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
  };

  const res = await agent
    .post('/api/v1/auth/local')
    .send({ email: 'admin@seerr.dev', password: 'test1234' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return agent;
}

describe('Trakt settings credential safety', () => {
  beforeEach(() => {
    clearSyncCache();
    clearIntegrationHealthCache();
    const settings = getSettings();
    settings.trakt = {
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
    };
    settings.mdblist = { ...settings.mdblist, apiKey: '' };
    settings.jellyfin = { ...settings.jellyfin, ip: '', apiKey: '' };
  });

  it('requires confirmation before changing credentials with linked accounts', async () => {
    const agent = await loginAsAdmin();
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
      relations: { settings: true },
    });
    const userSettings = user.settings ?? new UserSettings({ user });
    userSettings.traktAccessToken = 'linked-access';
    userSettings.traktRefreshToken = 'linked-refresh';
    userSettings.traktTokenExpiresAt = String(
      Math.floor(Date.now() / 1000) + 3600
    );
    userSettings.traktUsername = 'linked-user';
    userSettings.traktUserId = 'linked-trakt-id';
    await getRepository(UserSettings).save(userSettings);

    const res = await agent.post('/api/v1/settings/trakt').send({
      clientId: 'new-client-id',
      clientSecret: 'new-client-secret',
      actionsEnabled: true,
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.linkedAccountCount, 1);
    assert.match(res.body.message ?? '', /confirmDisconnectLinkedAccounts/i);

    const persisted = await getRepository(UserSettings)
      .createQueryBuilder('settings')
      .addSelect('settings.traktAccessToken')
      .leftJoin('settings.user', 'user')
      .where('user.id = :userId', { userId: user.id })
      .getOneOrFail();
    assert.equal(persisted.traktAccessToken, 'linked-access');
  });

  it('disconnects linked accounts only after settings persistence succeeds', async () => {
    const validateMock = mock.method(
      TraktAPI.prototype,
      'validateApplicationCredentials',
      async () => undefined
    );
    const agent = await loginAsAdmin();
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
      relations: { settings: true },
    });
    const userSettings = user.settings ?? new UserSettings({ user });
    userSettings.traktAccessToken = 'linked-access';
    userSettings.traktRefreshToken = 'linked-refresh';
    userSettings.traktTokenExpiresAt = String(
      Math.floor(Date.now() / 1000) + 3600
    );
    userSettings.traktUsername = 'linked-user';
    userSettings.traktUserId = 'linked-trakt-id';
    await getRepository(UserSettings).save(userSettings);

    const res = await agent.post('/api/v1/settings/trakt').send({
      clientId: 'new-client-id',
      clientSecret: 'new-client-secret',
      actionsEnabled: true,
      confirmDisconnectLinkedAccounts: true,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.linkedAccountCount, 0);
    assert.equal(validateMock.mock.calls.length, 1);

    const persisted = await getRepository(UserSettings)
      .createQueryBuilder('settings')
      .addSelect('settings.traktAccessToken')
      .leftJoin('settings.user', 'user')
      .where('user.id = :userId', { userId: user.id })
      .getOneOrFail();
    assert.equal(persisted.traktAccessToken, null);

    validateMock.mock.restore();
  });

  it('preserves linked accounts when settings save fails', async () => {
    const validateMock = mock.method(
      TraktAPI.prototype,
      'validateApplicationCredentials',
      async () => undefined
    );
    const settings = getSettings();
    const saveMock = mock.method(settings, 'save', async () => {
      throw new Error('disk full');
    });

    const agent = await loginAsAdmin();
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
      relations: { settings: true },
    });
    const userSettings = user.settings ?? new UserSettings({ user });
    userSettings.traktAccessToken = 'linked-access';
    userSettings.traktRefreshToken = 'linked-refresh';
    userSettings.traktTokenExpiresAt = String(
      Math.floor(Date.now() / 1000) + 3600
    );
    userSettings.traktUsername = 'linked-user';
    userSettings.traktUserId = 'linked-trakt-id';
    await getRepository(UserSettings).save(userSettings);

    const res = await agent.post('/api/v1/settings/trakt').send({
      clientId: 'new-client-id',
      clientSecret: 'new-client-secret',
      actionsEnabled: true,
      confirmDisconnectLinkedAccounts: true,
    });

    assert.equal(res.status, 500);

    const persisted = await getRepository(UserSettings)
      .createQueryBuilder('settings')
      .addSelect('settings.traktAccessToken')
      .leftJoin('settings.user', 'user')
      .where('user.id = :userId', { userId: user.id })
      .getOneOrFail();
    assert.equal(persisted.traktAccessToken, 'linked-access');

    saveMock.mock.restore();
    validateMock.mock.restore();
  });

  it('clears user Trakt state when switching to the Jellyfin provider', async () => {
    const jellyfinMock = mock.method(
      JellyfinAPI.prototype,
      'getSystemInfo',
      async () => ({ Id: 'jellyfin-server' })
    );
    const agent = await loginAsAdmin();
    const settings = getSettings();
    settings.jellyfin = {
      ...settings.jellyfin,
      ip: 'jellyfin.example.test',
      apiKey: 'jellyfin-api-key',
    };
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
      relations: { settings: true },
    });
    const userSettings = user.settings ?? new UserSettings({ user });
    userSettings.traktAccessToken = 'linked-access';
    userSettings.traktRefreshToken = 'linked-refresh';
    await getRepository(UserSettings).save(userSettings);
    seedUserSyncCache(1, {
      watchedMovies: [{ movie: { ids: { tmdb: 123 } } }],
      watchedShows: [],
      ratingsMovies: [],
      ratingsShows: [],
      fetchedAt: Date.now() / 1000,
    });

    const res = await agent.post('/api/v1/settings/trakt').send({
      provider: 'jellyfin',
      clientId: 'test-client-id',
      clientSecret: '',
      actionsEnabled: true,
      confirmProviderSwitch: true,
    });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.clientId, '');
    assert.equal(res.body.clientSecret, '');
    assert.deepEqual(getSettings().trakt, {
      provider: 'jellyfin',
      clientId: '',
      clientSecret: '',
    });
    assert.equal(getUserSyncSnapshot(1), undefined);

    const persisted = await getRepository(UserSettings)
      .createQueryBuilder('settings')
      .addSelect('settings.traktAccessToken')
      .leftJoin('settings.user', 'user')
      .where('user.id = :userId', { userId: user.id })
      .getOneOrFail();
    assert.equal(persisted.traktAccessToken, null);
    jellyfinMock.mock.restore();
  });

  it('requires explicit confirmation before switching providers', async () => {
    const agent = await loginAsAdmin();
    const res = await agent.post('/api/v1/settings/trakt').send({
      provider: 'jellyfin',
      actionsEnabled: true,
    });

    assert.equal(res.status, 400);
    assert.match(res.body.message ?? '', /confirmProviderSwitch/i);
    assert.equal(getSettings().trakt.provider ?? 'direct', 'direct');
  });

  it('reports live health for direct Trakt and MDBList', async () => {
    const traktMock = mock.method(
      TraktAPI.prototype,
      'validateApplicationCredentials',
      async () => undefined
    );
    const mdblistMock = mock.method(
      MdblistAPI.prototype,
      'validateApiKey',
      async () => undefined
    );
    const agent = await loginAsAdmin();
    const settings = getSettings();
    settings.mdblist = { ...settings.mdblist, apiKey: 'test-mdblist-key' };

    const res = await agent.get('/api/v1/settings/integrations/status');

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.trakt.provider, 'direct');
    assert.equal(res.body.trakt.state, 'healthy');
    assert.equal(
      res.body.trakt.detail,
      'Trakt is reachable and the Client ID was accepted.'
    );
    assert.deepEqual(res.body.trakt.direct, {
      state: 'healthy',
      detail: 'Trakt is reachable and the Client ID was accepted.',
      checkedAt: res.body.trakt.direct.checkedAt,
    });
    assert.equal(res.body.trakt.jellyfin.state, 'not_configured');
    assert.equal(res.body.mdblist.state, 'healthy');
    assert.equal(mdblistMock.mock.calls.length, 1);
    assert.equal(traktMock.mock.calls.length, 1);

    mdblistMock.mock.restore();
    traktMock.mock.restore();
  });

  it('reports a reachable Better Trakt bridge separately from user access', async () => {
    const jellyfinMock = mock.method(
      JellyfinAPI.prototype,
      'getSystemInfo',
      async () => ({ Id: 'jellyfin-server' })
    );
    const betterTraktMock = mock.method(axios, 'get', async () => ({
      data: { IsLinked: true, AllowExternalTokenAccess: true },
    }));
    const agent = await loginAsAdmin();
    const settings = getSettings();
    settings.trakt = { provider: 'jellyfin', clientId: '', clientSecret: '' };
    settings.jellyfin = {
      ...settings.jellyfin,
      ip: 'jellyfin.example.test',
      apiKey: 'jellyfin-api-key',
    };
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    user.jellyfinUserId = 'jellyfin-user-id';
    user.jellyfinAuthToken = 'jellyfin-user-token';
    await getRepository(User).save(user);

    const res = await agent.get('/api/v1/settings/integrations/status');

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.trakt.provider, 'jellyfin');
    assert.equal(res.body.trakt.state, 'healthy');
    assert.match(res.body.trakt.detail, /ready for all 1 linked users/i);
    assert.equal(res.body.trakt.jellyfin.readiness.readyUsers, 1);
    assert.equal(res.body.trakt.jellyfin.readiness.users[0].state, 'ready');
    assert.equal(jellyfinMock.mock.calls.length, 1);
    assert.equal(betterTraktMock.mock.calls.length, 1);

    betterTraktMock.mock.restore();
    jellyfinMock.mock.restore();
  });

  it('updates watched and rating actions without changing provider settings', async () => {
    const agent = await loginAsAdmin();
    const before = { ...getSettings().trakt };

    const res = await agent
      .post('/api/v1/settings/trakt/actions')
      .send({ actionsEnabled: false });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.actionsEnabled, false);
    assert.deepEqual(getSettings().trakt, before);
    assert.equal(getSettings().mediaActions.providers.trakt, false);
  });
});
