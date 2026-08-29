import { getRepository } from '@server/datasource';
import { MappingGap } from '@server/entity/MappingGap';
import { MappingOverride } from '@server/entity/MappingOverride';
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

const seedGap = async (overrides: Partial<MappingGap> = {}) => {
  const now = new Date();
  const { identifiers } = await getRepository(MappingGap).insert({
    namespace: 'simkl',
    externalId: '2419656',
    season: -1,
    title: 'Ore dake Level Up na Ken',
    mediaType: 'tv',
    discoverSource: 'simkl/premieres/anime',
    reason: 'ambiguous',
    status: 'open',
    hitCount: 7,
    firstSeenAt: now,
    lastSeenAt: now,
    ...overrides,
  });
  return identifiers[0].id as number;
};

beforeEach(async () => {
  await getRepository(MappingGap).clear();
  await getRepository(MappingOverride).clear();
});

describe('mapping settings API', () => {
  it('reports health in the documented shape', async () => {
    const agent = await loginAsAdmin();
    await seedGap();

    const res = await agent.get('/api/v1/settings/mapping/health');

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.gaps.openGaps, 1);
    assert.equal(res.body.gaps.totalHits, 7);
    assert.ok(Array.isArray(res.body.budgets));
    assert.ok(
      res.body.budgets.some((row: { key: string }) => row.key === 'tmdb-find')
    );
    assert.ok(Array.isArray(res.body.usage));
    assert.ok(Array.isArray(res.body.resolvers));
    assert.ok(Array.isArray(res.body.refreshes));
  });

  it('lists gaps most-seen first', async () => {
    const agent = await loginAsAdmin();
    await seedGap({ externalId: '1', hitCount: 2 });
    await seedGap({ externalId: '2', hitCount: 40 });

    const res = await agent.get('/api/v1/settings/mapping/gaps?take=10');

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.total, 2);
    assert.equal(res.body.results[0].externalId, '2');
  });

  it('stores a correction as an override and closes the gap', async () => {
    const agent = await loginAsAdmin();
    const id = await seedGap();

    const res = await agent
      .post(`/api/v1/settings/mapping/gaps/${id}/resolve`)
      .send({ toNamespace: 'tmdb_show', toExternalId: '127532' });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [override] = await getRepository(MappingOverride).find();
    assert.equal(override.fromNamespace, 'simkl');
    assert.equal(override.toExternalId, '127532');
    const gap = await getRepository(MappingGap).findOneBy({ id });
    assert.equal(gap?.status, 'resolved');
  });

  it('records an absence when the target id is left empty', async () => {
    const agent = await loginAsAdmin();
    const id = await seedGap();

    const res = await agent
      .post(`/api/v1/settings/mapping/gaps/${id}/resolve`)
      .send({ toNamespace: 'tmdb_show', toExternalId: '' });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [override] = await getRepository(MappingOverride).find();
    assert.equal(override.toExternalId, '');
  });

  it('rejects an unknown namespace instead of storing a broken override', async () => {
    const agent = await loginAsAdmin();
    const id = await seedGap();

    const res = await agent
      .post(`/api/v1/settings/mapping/gaps/${id}/resolve`)
      .send({ toNamespace: 'nonsense', toExternalId: '1' });

    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(await getRepository(MappingOverride).count(), 0);
  });

  it('creates an override directly from a discover tile', async () => {
    const agent = await loginAsAdmin();

    const res = await agent.post('/api/v1/settings/mapping/overrides').send({
      fromNamespace: 'anilist',
      fromExternalId: '110277',
      toNamespace: 'tmdb_show',
      toExternalId: '1429',
      note: 'checked against the AniList page',
    });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [override] = await getRepository(MappingOverride).find();
    assert.equal(override.fromExternalId, '110277');
    assert.equal(override.toExternalId, '1429');
  });

  it('round-trips an override export through import', async () => {
    const agent = await loginAsAdmin();
    await agent.post('/api/v1/settings/mapping/overrides').send({
      fromNamespace: 'anilist',
      fromExternalId: '110277',
      toNamespace: 'tmdb_show',
      toExternalId: '1429',
    });

    const exported = await agent.get('/api/v1/settings/mapping/overrides');
    assert.equal(exported.status, 200, JSON.stringify(exported.body));
    await getRepository(MappingOverride).clear();

    const imported = await agent
      .post('/api/v1/settings/mapping/overrides/import')
      .send({ overrides: exported.body.results });

    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.equal(imported.body.imported, 1);
    assert.equal(await getRepository(MappingOverride).count(), 1);
  });

  it('lists sources together with the manifest entries available to add', async () => {
    const agent = await loginAsAdmin();

    const res = await agent.get('/api/v1/settings/mapping/sources');

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(Array.isArray(res.body.results));
    assert.ok(
      res.body.available.some(
        (pack: { key: string }) => pack.key === 'anibridge'
      )
    );
  });

  it('refuses a refresh for a pack that is not in the manifest', async () => {
    const agent = await loginAsAdmin();

    const res = await agent.post(
      '/api/v1/settings/mapping/sources/not-a-pack/refresh'
    );

    assert.equal(res.status, 404, JSON.stringify(res.body));
  });

  it('requires an authenticated admin', async () => {
    const res = await request(app).get('/api/v1/settings/mapping/health');
    assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
  });
});
