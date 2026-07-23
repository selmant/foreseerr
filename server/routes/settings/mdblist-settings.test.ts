import MdblistAPI from '@server/api/mdblist';
import cacheManager from '@server/lib/cache';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import settingsRoutes from '@server/routes/settings';
import { setupTestDb } from '@server/test/db';
import cookieParser from 'cookie-parser';
import type { Express } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import session from 'express-session';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, beforeEach, describe, it } from 'node:test';
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

  const res = await agent
    .post('/api/v1/auth/local')
    .send({ email: 'admin@seerr.dev', password: 'test1234' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return agent;
}

describe('MDBList settings credential safety', () => {
  beforeEach(() => {
    MdblistAPI.resetInstance();
    getSettings().mdblist = {
      apiKey: 'real-mdblist-key',
      showTmdb: true,
      showImdb: true,
      showRt: true,
      showRtUser: true,
      showMetacritic: true,
      showTraktCommunity: true,
      posterTmdb: true,
      posterImdb: true,
      posterRt: true,
      posterRtUser: false,
      posterMetacritic: false,
      posterTraktCommunity: false,
    };
    cacheManager.getCache('mdblist').flush();
  });

  it('masks the API key on GET and never returns the real value', async () => {
    const agent = await loginAsAdmin();
    const res = await agent.get('/api/v1/settings/mdblist');

    assert.equal(res.status, 200);
    assert.equal(res.body.apiKey, '********');
    assert.equal(res.body.configured, true);
    assert.notEqual(res.body.apiKey, 'real-mdblist-key');
  });

  it('preserves the stored key when the masked placeholder is submitted', async () => {
    const agent = await loginAsAdmin();
    const res = await agent.post('/api/v1/settings/mdblist').send({
      apiKey: '********',
      showImdb: false,
    });

    assert.equal(res.status, 200);
    assert.equal(getSettings().mdblist.apiKey, 'real-mdblist-key');
    assert.equal(res.body.apiKey, '********');
    assert.equal(res.body.showImdb, false);
  });

  it('clears the API key when clearApiKey is true', async () => {
    const agent = await loginAsAdmin();
    cacheManager.getCache('mdblist').data.set('probe', 'cached');

    const res = await agent.post('/api/v1/settings/mdblist').send({
      clearApiKey: true,
      apiKey: '********',
      showImdb: true,
    });

    assert.equal(res.status, 200);
    assert.equal(getSettings().mdblist.apiKey, '');
    assert.equal(res.body.configured, false);
    assert.equal(res.body.apiKey, '');
    assert.equal(cacheManager.getCache('mdblist').data.get('probe'), undefined);
  });
});
