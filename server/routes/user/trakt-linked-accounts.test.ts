import TraktAPI, {
  TraktReconnectRequiredError,
  TraktRefreshRejectedError,
} from '@server/api/trakt';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { getSettings } from '@server/lib/settings';
import { refreshUserTraktTokens } from '@server/lib/trakt';
import {
  TRAKT_DEVICE_CODE_MAX_PER_WINDOW,
  resetTraktDeviceAuthThrottleState,
} from '@server/lib/trakt/deviceAuthThrottle';
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
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return agent;
}

describe('Trakt linked-accounts routes (OpenAPI + handlers)', () => {
  beforeEach(() => {
    resetTraktDeviceAuthThrottleState();
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
    assert.equal(res.status, 401, JSON.stringify(res.body));
  });

  it('GET returns connected=false before linking', async () => {
    const agent = await loginAsAdmin();
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    await agent.post(
      `/api/v1/user/${user.id}/settings/linked-accounts/trakt/device/code`
    );

    const res = await agent.get(
      `/api/v1/user/${user.id}/settings/linked-accounts/trakt`
    );

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      connected: false,
      username: null,
    });
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

  it('POST device/code is rate-limited per user', async () => {
    const agent = await loginAsAdmin();
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    for (
      let attempt = 0;
      attempt < TRAKT_DEVICE_CODE_MAX_PER_WINDOW;
      attempt++
    ) {
      const res = await agent.post(
        `/api/v1/user/${user.id}/settings/linked-accounts/trakt/device/code`
      );
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }

    const limited = await agent.post(
      `/api/v1/user/${user.id}/settings/linked-accounts/trakt/device/code`
    );
    assert.equal(limited.status, 429);
  });

  it('POST device/token enforces Trakt polling interval', async () => {
    pollForTokenMock.mock.mockImplementation(async () => ({
      status: 'pending' as const,
    }));

    const agent = await loginAsAdmin();
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const codeRes = await agent.post(
      `/api/v1/user/${user.id}/settings/linked-accounts/trakt/device/code`
    );
    assert.equal(codeRes.status, 200);

    const firstPoll = await agent
      .post(
        `/api/v1/user/${user.id}/settings/linked-accounts/trakt/device/token`
      )
      .send({ deviceCode: 'device-abc' });
    assert.equal(firstPoll.status, 202);

    const immediateSecondPoll = await agent
      .post(
        `/api/v1/user/${user.id}/settings/linked-accounts/trakt/device/token`
      )
      .send({ deviceCode: 'device-abc' });
    assert.equal(immediateSecondPoll.status, 429);
    assert.equal(immediateSecondPoll.body.retryAfterSeconds, 5);
    assert.equal(pollForTokenMock.mock.calls.length, 1);
  });

  it('POST device/token returns 202 while pending', async () => {
    pollForTokenMock.mock.mockImplementation(async () => ({
      status: 'pending' as const,
    }));

    const agent = await loginAsAdmin();
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    await agent.post(
      `/api/v1/user/${user.id}/settings/linked-accounts/trakt/device/code`
    );

    const res = await agent
      .post(
        `/api/v1/user/${user.id}/settings/linked-accounts/trakt/device/token`
      )
      .send({ deviceCode: 'device-abc' });

    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { status: 'pending' });
  });

  it('POST device/token backs off when Trakt requests slower polling', async () => {
    pollForTokenMock.mock.mockImplementation(async () => ({
      status: 'slow_down' as const,
    }));

    const agent = await loginAsAdmin();
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    await agent.post(
      `/api/v1/user/${user.id}/settings/linked-accounts/trakt/device/code`
    );

    const res = await agent
      .post(
        `/api/v1/user/${user.id}/settings/linked-accounts/trakt/device/token`
      )
      .send({ deviceCode: 'device-abc' });

    assert.equal(res.status, 202);
    assert.deepEqual(res.body, {
      status: 'pending',
      retryAfterSeconds: 10,
    });
  });

  it('POST device/token treats an already-used code as terminal', async () => {
    pollForTokenMock.mock.mockImplementation(async () => ({
      status: 'already_used' as const,
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

    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { status: 'already_used' });
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
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    }));

    const agent = await loginAsAdmin();
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    await agent.post(
      `/api/v1/user/${user.id}/settings/linked-accounts/trakt/device/code`
    );

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
    assert.equal(settings?.traktUserId, 'trakt-user-1');
  });

  it('rejects linking the same Trakt account to another Foreseer user', async () => {
    pollForTokenMock.mock.mockImplementation(async () => ({
      status: 'authorized' as const,
      tokens: {
        access_token: 'access-2',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'refresh-2',
        scope: 'public',
        created_at: Math.floor(Date.now() / 1000),
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    }));

    const agent = await loginAsAdmin();
    const admin = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    const friend = await getRepository(User).findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });

    const adminLink = await agent
      .post(
        `/api/v1/user/${admin.id}/settings/linked-accounts/trakt/device/token`
      )
      .send({ deviceCode: 'device-abc' });
    assert.equal(adminLink.status, 200);

    const friendAgent = request.agent(app);
    await friendAgent
      .post('/api/v1/auth/local')
      .send({ email: 'friend@seerr.dev', password: 'test1234' });

    const friendLink = await friendAgent
      .post(
        `/api/v1/user/${friend.id}/settings/linked-accounts/trakt/device/token`
      )
      .send({ deviceCode: 'device-abc' });

    assert.equal(friendLink.status, 409);
    assert.match(friendLink.body.message ?? '', /already linked/i);
  });

  it('enforces unique traktUserId in the database', async () => {
    const admin = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
      relations: { settings: true },
    });
    const friend = await getRepository(User).findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });

    const adminSettings = admin.settings ?? new UserSettings({ user: admin });
    adminSettings.traktUserId = 'shared-trakt-id';
    await getRepository(UserSettings).save(adminSettings);

    const friendSettings = new UserSettings({ user: friend });
    friendSettings.traktUserId = 'shared-trakt-id';

    await assert.rejects(
      getRepository(UserSettings).save(friendSettings),
      /UNIQUE|unique/i
    );
  });

  it('backfills traktUserId during token refresh when missing', async () => {
    await loginAsAdmin();
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
      relations: { settings: true },
    });
    const settings = user.settings ?? new UserSettings({ user });
    const callerTokens = {
      accessToken: 'legacy-access',
      refreshToken: 'legacy-refresh',
      expiresAt: Math.floor(Date.now() / 1000),
    };
    settings.traktAccessToken = callerTokens.accessToken;
    settings.traktRefreshToken = callerTokens.refreshToken;
    settings.traktTokenExpiresAt = String(callerTokens.expiresAt);
    settings.traktUsername = 'trakt-user';
    settings.traktUserId = undefined;
    await getRepository(UserSettings).save(settings);

    const refreshMock = mock.method(
      TraktAPI.prototype,
      'refreshAccessToken',
      async () => ({
        accessToken: 'backfilled-access',
        refreshToken: 'backfilled-refresh',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      })
    );
    const profileMock = mock.method(
      TraktAPI.prototype,
      'getUserSettings',
      async () => ({
        username: 'trakt-user',
        traktUserId: 'trakt-user-1',
      })
    );

    try {
      await refreshUserTraktTokens(user.id, callerTokens);
      const persisted = await getRepository(UserSettings).findOneOrFail({
        where: { id: settings.id },
      });
      assert.equal(persisted.traktUserId, 'trakt-user-1');
    } finally {
      refreshMock.mock.restore();
      profileMock.mock.restore();
    }
  });

  it('DELETE unlinks Trakt account', async () => {
    const agent = await loginAsAdmin();
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    let settings = await getRepository(UserSettings).findOne({
      where: { user: { id: user.id } },
      relations: { user: true },
    });
    if (!settings) {
      settings = new UserSettings({ user });
    }
    settings.traktAccessToken = 'access-1';
    settings.traktRefreshToken = 'refresh-1';
    settings.traktTokenExpiresAt = String(Math.floor(Date.now() / 1000) + 3600);
    settings.traktUsername = 'trakt-user';
    settings.traktUserId = 'trakt-user-1';
    await getRepository(UserSettings).save(settings);

    const res = await agent.delete(
      `/api/v1/user/${user.id}/settings/linked-accounts/trakt`
    );
    assert.equal(res.status, 204);

    const status = await agent.get(
      `/api/v1/user/${user.id}/settings/linked-accounts/trakt`
    );
    assert.deepEqual(status.body, {
      connected: false,
      username: null,
    });
  });

  it('serializes concurrent refreshes and reuses the persisted token pair', async () => {
    await loginAsAdmin();
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
      relations: { settings: true },
    });
    const settings = user.settings ?? new UserSettings({ user });
    const callerTokens = {
      accessToken: 'expiring-access',
      refreshToken: 'rotating-refresh',
      expiresAt: Math.floor(Date.now() / 1000),
    };
    settings.traktAccessToken = callerTokens.accessToken;
    settings.traktRefreshToken = callerTokens.refreshToken;
    settings.traktTokenExpiresAt = String(callerTokens.expiresAt);
    settings.traktUsername = 'trakt-user';
    await getRepository(UserSettings).save(settings);

    let refreshCalls = 0;
    let releaseRefresh: (() => void) | undefined;
    let signalRefreshStarted: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshStarted = new Promise<void>((resolve) => {
      signalRefreshStarted = resolve;
    });
    const refreshMock = mock.method(
      TraktAPI.prototype,
      'refreshAccessToken',
      async () => {
        refreshCalls += 1;
        signalRefreshStarted?.();
        await refreshGate;
        return {
          accessToken: 'rotated-access',
          refreshToken: 'rotated-refresh',
          expiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
        };
      }
    );

    try {
      const first = refreshUserTraktTokens(user.id, callerTokens);
      const second = refreshUserTraktTokens(user.id, callerTokens);
      await refreshStarted;
      assert.equal(refreshCalls, 1);
      releaseRefresh?.();

      const [firstTokens, secondTokens] = await Promise.all([first, second]);
      assert.deepEqual(firstTokens, secondTokens);
      assert.equal(refreshCalls, 1);

      const persisted = await getRepository(UserSettings)
        .createQueryBuilder('settings')
        .addSelect('settings.traktAccessToken')
        .addSelect('settings.traktRefreshToken')
        .leftJoin('settings.user', 'user')
        .where('user.id = :userId', { userId: user.id })
        .getOneOrFail();
      assert.equal(persisted.traktAccessToken, 'rotated-access');
      assert.equal(persisted.traktRefreshToken, 'rotated-refresh');
    } finally {
      releaseRefresh?.();
      refreshMock.mock.restore();
    }
  });

  it('clears rejected refresh credentials and requires reconnection', async () => {
    const agent = await loginAsAdmin();
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
      relations: { settings: true },
    });
    const settings = user.settings ?? new UserSettings({ user });
    const callerTokens = {
      accessToken: 'rejected-access',
      refreshToken: 'rejected-refresh',
      expiresAt: Math.floor(Date.now() / 1000),
    };
    settings.traktAccessToken = callerTokens.accessToken;
    settings.traktRefreshToken = callerTokens.refreshToken;
    settings.traktTokenExpiresAt = String(callerTokens.expiresAt);
    settings.traktUsername = 'trakt-user';
    await getRepository(UserSettings).save(settings);

    const refreshMock = mock.method(
      TraktAPI.prototype,
      'refreshAccessToken',
      async () => {
        throw new TraktRefreshRejectedError(400);
      }
    );

    try {
      await assert.rejects(
        refreshUserTraktTokens(user.id, callerTokens),
        TraktReconnectRequiredError
      );
    } finally {
      refreshMock.mock.restore();
    }

    const status = await agent.get(
      `/api/v1/user/${user.id}/settings/linked-accounts/trakt`
    );
    assert.equal(status.status, 200);
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
