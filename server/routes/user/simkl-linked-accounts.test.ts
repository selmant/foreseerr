import { SimklUnauthorizedError } from '@server/api/simkl';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { getSettings } from '@server/lib/settings';
import {
  createSimklUserClient,
  getUserSimklSettings,
  refreshUserSimklTokens,
} from '@server/lib/simkl';
import { checkUser } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import userRoutes from '@server/routes/user';
import { setupTestDb } from '@server/test/db';
import axios, {
  AxiosError,
  type AxiosAdapter,
  type InternalAxiosRequestConfig,
} from 'axios';
import cookieParser from 'cookie-parser';
import type { Express } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import session from 'express-session';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import request from 'supertest';

const API_SPEC_PATH = join(__dirname, '../../../seerr-api.yml');
const previousAxiosAdapter = axios.defaults.adapter;

type Answer = { status: number; data: unknown };
type Call = { path: string; body: URLSearchParams };

/** Stubs Simkl's HTTP API; `route` sees the path without its query. */
const stubSimkl = (route: (call: Call) => Answer | Promise<Answer>) => {
  const calls: Call[] = [];
  axios.defaults.adapter = (async (config: InternalAxiosRequestConfig) => {
    const call = {
      path: String(config.url).split('?')[0],
      body: new URLSearchParams(
        typeof config.data === 'string' ? config.data : ''
      ),
    };
    calls.push(call);
    const { status, data } = await route(call);
    const response = { status, statusText: '', headers: {}, config, data };
    if (status < 400) return response;
    throw new AxiosError(
      `Request failed with status code ${status}`,
      AxiosError.ERR_BAD_REQUEST,
      config,
      undefined,
      response
    );
  }) as AxiosAdapter;
  return calls;
};

const PROFILE: Answer = {
  status: 200,
  data: { user: { name: 'Simkl User' }, account: { id: 4242 } },
};
const V2_TOKENS: Answer = {
  status: 200,
  data: {
    access_token: 'simkl_at_new',
    token_type: 'Bearer',
    expires_in: 604800,
    refresh_token: 'simkl_rt_refresh',
    scope: 'media:read media:write',
  },
};
const oauthError = (status: number, error: string): Answer => ({
  status,
  data: { error, error_description: error },
});

let app: Express;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(
    session({ secret: 'test-secret', resave: false, saveUninitialized: false })
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
  return app;
}

before(() => {
  app = createApp();
});

afterEach(() => {
  axios.defaults.adapter = previousAxiosAdapter;
  // Settings outlive this file: a configured Client ID would send later
  // files' integration health checks to the real Simkl.
  const settings = getSettings();
  settings.simkl = { ...settings.simkl, clientId: '' };
});

setupTestDb();

async function loginAsAdmin() {
  const settings = getSettings();
  settings.main.localLogin = true;
  settings.main.applicationUrl = 'http://localhost:5055';
  settings.simkl = { ...settings.simkl, clientId: 'test-client' };
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/local')
    .send({ email: 'admin@seerr.dev', password: 'test1234' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const user = await getRepository(User).findOneOrFail({
    where: { email: 'admin@seerr.dev' },
  });
  return { agent, base: `/api/v1/user/${user.id}/settings`, userId: user.id };
}

const DEVICE_CODE: Answer = {
  status: 200,
  data: {
    device_code: 'device-secret',
    user_code: 'BDWP-HQPK',
    verification_uri: 'https://simkl.com/pin',
    verification_uri_complete: 'https://simkl.com/pin?user_code=BDWP-HQPK',
    expires_in: 900,
    interval: 5,
  },
};

describe('Simkl linking (AUTH V2 device flow)', () => {
  let tokenAnswer: Answer;
  let calls: Call[];

  beforeEach(() => {
    tokenAnswer = oauthError(400, 'authorization_pending');
    calls = stubSimkl(({ path }) => {
      if (path === '/oauth2/device') return DEVICE_CODE;
      if (path === '/oauth2/token') return tokenAnswer;
      if (path === '/users/settings') return PROFILE;
      return { status: 404, data: {} };
    });
  });

  it('keeps the device code on the server', async () => {
    const { agent, base } = await loginAsAdmin();
    const res = await agent.post(`${base}/linked-accounts/simkl/pin/code`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.userCode, 'BDWP-HQPK');
    assert.equal(
      res.body.verificationUri,
      'https://simkl.com/pin?user_code=BDWP-HQPK'
    );
    assert.notEqual(res.body.deviceCode, 'device-secret');
    assert.ok(!JSON.stringify(res.body).includes('device-secret'));
    assert.equal(
      calls[0].body.get('scope'),
      'media:read media:write',
      'Foreseerr writes history and ratings'
    );
  });

  it('reports pending, then stores the token pair once approved', async () => {
    const { agent, base, userId } = await loginAsAdmin();
    const code = await agent.post(`${base}/linked-accounts/simkl/pin/code`);
    const pending = await agent
      .post(`${base}/linked-accounts/simkl/pin/token`)
      .send({ deviceCode: code.body.deviceCode });
    assert.equal(pending.status, 202, JSON.stringify(pending.body));
    const poll = calls.find((call) => call.path === '/oauth2/token');
    assert.equal(poll?.body.get('device_code'), 'device-secret');
    assert.equal(
      poll?.body.get('grant_type'),
      'urn:ietf:params:oauth:grant-type:device_code'
    );

    // A second poll inside the interval never reaches Simkl.
    const tooSoon = await agent
      .post(`${base}/linked-accounts/simkl/pin/token`)
      .send({ deviceCode: code.body.deviceCode });
    assert.equal(tooSoon.status, 429);
    assert.equal(
      calls.filter((call) => call.path === '/oauth2/token').length,
      1
    );

    // Start a fresh session to skip the interval, now approved.
    tokenAnswer = V2_TOKENS;
    const approved = await agent.post(`${base}/linked-accounts/simkl/pin/code`);
    const res = await agent
      .post(`${base}/linked-accounts/simkl/pin/token`)
      .send({ deviceCode: approved.body.deviceCode });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const settings = await getUserSimklSettings(userId);
    assert.equal(settings?.simklAccessToken, 'simkl_at_new');
    assert.equal(settings?.simklRefreshToken, 'simkl_rt_refresh');
    assert.equal(settings?.simklUserId, '4242');
    const expiresIn =
      Number(settings?.simklTokenExpiresAt) - Math.floor(Date.now() / 1000);
    assert.ok(Math.abs(expiresIn - 604800) < 60, String(expiresIn));
  });

  it('backs off by five seconds on slow_down', async () => {
    tokenAnswer = oauthError(400, 'slow_down');
    const { agent, base } = await loginAsAdmin();
    const code = await agent.post(`${base}/linked-accounts/simkl/pin/code`);
    const res = await agent
      .post(`${base}/linked-accounts/simkl/pin/token`)
      .send({ deviceCode: code.body.deviceCode });
    assert.equal(res.status, 429);
    assert.equal(res.body.retryAfterSeconds, 10);
  });

  it('ends the session when the device code expires', async () => {
    tokenAnswer = oauthError(400, 'expired_token');
    const { agent, base } = await loginAsAdmin();
    const code = await agent.post(`${base}/linked-accounts/simkl/pin/code`);
    const res = await agent
      .post(`${base}/linked-accounts/simkl/pin/token`)
      .send({ deviceCode: code.body.deviceCode });
    assert.equal(res.status, 410);
  });

  it('revokes the grant on unlink', async () => {
    tokenAnswer = V2_TOKENS;
    const { agent, base, userId } = await loginAsAdmin();
    const code = await agent.post(`${base}/linked-accounts/simkl/pin/code`);
    await agent
      .post(`${base}/linked-accounts/simkl/pin/token`)
      .send({ deviceCode: code.body.deviceCode });
    const res = await agent.delete(`${base}/linked-accounts/simkl`);
    assert.equal(res.status, 204);
    const revoke = calls.find((call) => call.path === '/oauth2/revoke');
    assert.equal(revoke?.body.get('token'), 'simkl_rt_refresh');
    const settings = await getUserSimklSettings(userId);
    assert.equal(settings?.simklAccessToken, null);
    assert.equal(settings?.simklRefreshToken, null);
  });
});

describe('Simkl linking (AUTH V1 fallback)', () => {
  it('uses the PIN flow when the Client ID belongs to a V1 app', async () => {
    const calls = stubSimkl(({ path }) => {
      if (path === '/oauth2/device') return oauthError(401, 'invalid_client');
      if (path === '/oauth/pin')
        return {
          status: 200,
          data: { user_code: 'ABCDE', url: 'https://simkl.com/pin/' },
        };
      if (path === '/oauth/pin/ABCDE')
        return { status: 200, data: { access_token: 'v1-token' } };
      if (path === '/users/settings') return PROFILE;
      return { status: 404, data: {} };
    });
    const { agent, base, userId } = await loginAsAdmin();
    const code = await agent.post(`${base}/linked-accounts/simkl/pin/code`);
    assert.equal(code.status, 200, JSON.stringify(code.body));
    assert.equal(code.body.userCode, 'ABCDE');
    assert.equal(code.body.verificationUri, 'https://simkl.com/pin/');
    const res = await agent
      .post(`${base}/linked-accounts/simkl/pin/token`)
      .send({ deviceCode: code.body.deviceCode });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(calls.some((call) => call.path === '/oauth/pin/ABCDE'));
    const settings = await getUserSimklSettings(userId);
    assert.equal(settings?.simklAccessToken, 'v1-token');
    assert.equal(settings?.simklRefreshToken, null);
    assert.equal(settings?.simklTokenExpiresAt, null);
  });
});

describe('Simkl token refresh', () => {
  const linkV2 = async () => {
    const { userId } = await loginAsAdmin();
    const repository = getRepository(UserSettings);
    const settings =
      (await repository.findOne({ where: { user: { id: userId } } })) ??
      repository.create({ user: { id: userId } });
    Object.assign(settings, {
      simklAccessToken: 'simkl_at_old',
      simklRefreshToken: 'simkl_rt_refresh',
      simklTokenExpiresAt: String(Math.floor(Date.now() / 1000) + 60),
      simklUserId: '4242',
    });
    await repository.save(settings);
    return userId;
  };

  it('refreshes once for concurrent callers holding the same token', async () => {
    const userId = await linkV2();
    const calls = stubSimkl(() => V2_TOKENS);
    const [first, second] = await Promise.all([
      refreshUserSimklTokens(userId, 'simkl_at_old'),
      refreshUserSimklTokens(userId, 'simkl_at_old'),
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.get('grant_type'), 'refresh_token');
    assert.equal(calls[0].body.get('refresh_token'), 'simkl_rt_refresh');
    assert.equal(first.accessToken, 'simkl_at_new');
    assert.equal(second.accessToken, 'simkl_at_new');
    const settings = await getUserSimklSettings(userId);
    assert.equal(settings?.simklAccessToken, 'simkl_at_new');
    assert.equal(settings?.simklRefreshToken, 'simkl_rt_refresh');
  });

  it('unlinks when Simkl rejects the refresh token', async () => {
    const userId = await linkV2();
    stubSimkl(() => oauthError(400, 'invalid_grant'));
    await assert.rejects(
      refreshUserSimklTokens(userId, 'simkl_at_old'),
      SimklUnauthorizedError
    );
    const settings = await getUserSimklSettings(userId);
    assert.equal(settings?.simklAccessToken, null);
    assert.equal(settings?.simklRefreshToken, null);
    assert.equal(settings?.simklUserId, null);
  });

  it('does not restore a link removed while the refresh was in flight', async () => {
    const userId = await linkV2();
    const settingsId = (await getUserSimklSettings(userId))?.id;
    stubSimkl(async () => {
      await getRepository(UserSettings).update(settingsId as number, {
        simklAccessToken: () => 'NULL',
        simklRefreshToken: () => 'NULL',
        simklUserId: () => 'NULL',
      });
      return V2_TOKENS;
    });
    await assert.rejects(
      refreshUserSimklTokens(userId, 'simkl_at_old'),
      SimklUnauthorizedError
    );
    const settings = await getUserSimklSettings(userId);
    assert.equal(settings?.simklAccessToken, null);
    assert.equal(settings?.simklRefreshToken, null);
  });

  it('leaves a newer link alone when the old grant is rejected', async () => {
    const userId = await linkV2();
    const settingsId = (await getUserSimklSettings(userId))?.id;
    stubSimkl(async () => {
      await getRepository(UserSettings).update(settingsId as number, {
        simklAccessToken: 'simkl_at_relinked',
        simklRefreshToken: 'simkl_rt_relinked',
      });
      return oauthError(400, 'invalid_grant');
    });
    await assert.rejects(
      refreshUserSimklTokens(userId, 'simkl_at_old'),
      SimklUnauthorizedError
    );
    const settings = await getUserSimklSettings(userId);
    assert.equal(settings?.simklAccessToken, 'simkl_at_relinked');
    assert.equal(settings?.simklUserId, '4242');
  });

  it('keeps the link through a temporary failure', async () => {
    const userId = await linkV2();
    stubSimkl(() => ({ status: 503, data: 'down' }));
    await assert.rejects(refreshUserSimklTokens(userId, 'simkl_at_old'));
    const settings = await getUserSimklSettings(userId);
    assert.equal(settings?.simklRefreshToken, 'simkl_rt_refresh');
  });

  it('leaves a newer link alone when a request with the old token gets a 401', async () => {
    const userId = await linkV2();
    const settingsId = (await getUserSimklSettings(userId))?.id as number;
    // A V1 link: the 401 unlinks without trying a refresh.
    await getRepository(UserSettings).update(settingsId, {
      simklRefreshToken: () => 'NULL',
      simklTokenExpiresAt: () => 'NULL',
    });
    stubSimkl(async () => {
      await getRepository(UserSettings).update(settingsId, {
        simklAccessToken: 'simkl_at_relinked',
      });
      return { status: 401, data: {} };
    });
    const client = await createSimklUserClient(userId);
    await assert.rejects(client.getActivities(), SimklUnauthorizedError);
    const settings = await getUserSimklSettings(userId);
    assert.equal(settings?.simklAccessToken, 'simkl_at_relinked');
    assert.equal(settings?.simklUserId, '4242');
  });

  it('unlinks when a request with the stored token gets a 401', async () => {
    const userId = await linkV2();
    const settingsId = (await getUserSimklSettings(userId))?.id as number;
    await getRepository(UserSettings).update(settingsId, {
      simklRefreshToken: () => 'NULL',
      simklTokenExpiresAt: () => 'NULL',
    });
    stubSimkl(() => ({ status: 401, data: {} }));
    const client = await createSimklUserClient(userId);
    await assert.rejects(client.getActivities(), SimklUnauthorizedError);
    const settings = await getUserSimklSettings(userId);
    assert.equal(settings?.simklAccessToken, null);
    assert.equal(settings?.simklUserId, null);
  });
});
