import TraktAPI from '@server/api/trakt';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import userRoutes from '@server/routes/user';
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

const API_SPEC_PATH = join(__dirname, '../../../seerr-api.yml');

const deviceCodeResponse = {
  device_code: 'device-abc',
  user_code: 'ABCD-1234',
  verification_url: 'https://trakt.tv/activate',
  expires_in: 600,
  interval: 5,
};

const requestDeviceCodeMock = mock.method(
  TraktAPI.prototype,
  'requestDeviceCode',
  async () => ({ ...deviceCodeResponse })
);

const pollForTokenMock = mock.method(
  TraktAPI.prototype,
  'pollForToken',
  async () =>
    ({
      status: 'pending' as const,
    }) as Awaited<ReturnType<TraktAPI['pollForToken']>>
);

const getUserSettingsMock = mock.method(
  TraktAPI.prototype,
  'getUserSettings',
  async () => ({
    username: 'trakt-user',
    traktUserId: 'trakt-user-1',
  })
);

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
  app.use('/api/v1/user', userRoutes);
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
  assert.equal(res.status, 200);
  return agent;
}

describe('Trakt linked-accounts routes (OpenAPI + handlers)', () => {
  beforeEach(() => {
    requestDeviceCodeMock.mock.resetCalls();
    pollForTokenMock.mock.resetCalls();
    getUserSettingsMock.mock.resetCalls();
    pollForTokenMock.mock.mockImplementation(async () => ({
      status: 'pending' as const,
    }));
  });

  it('rejects unauthenticated GET with cookie security (not path-not-found)', async () => {
    const res = await request(app).get(
      '/api/v1/user/1/settings/linked-accounts/trakt'
    );

    assert.notEqual(
      res.body?.message,
      'not found',
      'OpenAPI must register this path; got validator not-found'
    );
    assert.equal(res.status, 401);
  });

  it('GET returns connected=false before linking', async () => {
    const agent = await loginAsAdmin();
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const res = await agent.get(
      `/api/v1/user/${user.id}/settings/linked-accounts/trakt`
    );

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { connected: false, username: null });
  });

  it('POST device/code returns Trakt device payload', async () => {
    const agent = await loginAsAdmin();
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const res = await agent.post(
      `/api/v1/user/${user.id}/settings/linked-accounts/trakt/device/code`
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.user_code, 'ABCD-1234');
    assert.equal(res.body.verification_url, 'https://trakt.tv/activate');
    assert.equal(requestDeviceCodeMock.mock.calls.length, 1);
  });

  it('POST device/token returns 202 while pending', async () => {
    pollForTokenMock.mock.mockImplementation(async () => ({
      status: 'pending' as const,
    }));

    const agent = await loginAsAdmin();
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const res = await agent
      .post(
        `/api/v1/user/${user.id}/settings/linked-accounts/trakt/device/token`
      )
      .send({ deviceCode: 'device-abc' });

    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { status: 'pending' });
  });

  it('POST device/token stores tokens on authorize', async () => {
    pollForTokenMock.mock.mockImplementation(async () => ({
      status: 'authorized' as const,
      tokens: {
        access_token: 'access-1',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'refresh-1',
        scope: 'public',
        created_at: Math.floor(Date.now() / 1000),
        expiresAt: Date.now() + 3600_000,
      },
    }));

    const agent = await loginAsAdmin();
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const res = await agent
      .post(
        `/api/v1/user/${user.id}/settings/linked-accounts/trakt/device/token`
      )
      .send({ deviceCode: 'device-abc' });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'authorized');
    assert.equal(res.body.username, 'trakt-user');
    assert.equal(getUserSettingsMock.mock.calls.length, 1);

    const status = await agent.get(
      `/api/v1/user/${user.id}/settings/linked-accounts/trakt`
    );
    assert.equal(status.status, 200);
    assert.deepEqual(status.body, {
      connected: true,
      username: 'trakt-user',
    });

    const settings = await getRepository(UserSettings)
      .createQueryBuilder('settings')
      .addSelect('settings.traktAccessToken')
      .leftJoin('settings.user', 'user')
      .where('user.id = :id', { id: user.id })
      .getOne();
    assert.equal(settings?.traktAccessToken, 'access-1');
    assert.equal(settings?.traktUsername, 'trakt-user');
  });

  it('DELETE unlinks Trakt account', async () => {
    const agent = await loginAsAdmin();
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    // Ensure linked from previous test or seed link
    let settings = await getRepository(UserSettings).findOne({
      where: { user: { id: user.id } },
      relations: { user: true },
    });
    if (!settings) {
      settings = new UserSettings({ user });
    }
    settings.traktAccessToken = 'access-1';
    settings.traktRefreshToken = 'refresh-1';
    settings.traktTokenExpiresAt = String(Date.now() + 3600_000);
    settings.traktUsername = 'trakt-user';
    await getRepository(UserSettings).save(settings);

    const res = await agent.delete(
      `/api/v1/user/${user.id}/settings/linked-accounts/trakt`
    );
    assert.equal(res.status, 204);

    const status = await agent.get(
      `/api/v1/user/${user.id}/settings/linked-accounts/trakt`
    );
    assert.deepEqual(status.body, { connected: false, username: null });
  });

  it('POST device/code returns 400 when Trakt is not configured', async () => {
    const agent = await loginAsAdmin();
    getSettings().trakt = { clientId: '', clientSecret: '' };
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const res = await agent.post(
      `/api/v1/user/${user.id}/settings/linked-accounts/trakt/device/code`
    );

    assert.equal(res.status, 400);
    assert.match(res.body.message ?? '', /not configured/i);
  });
});
