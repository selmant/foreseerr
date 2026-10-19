import SimklAPI from '@server/api/simkl';
import { SIMKL_BUILTIN_CLIENT_ID } from '@server/constants/simkl';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
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

const API_SPEC_PATH = join(__dirname, '../../../seerr-api.yml');

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
  app.use(
    '/api/v1/settings',
    isAuthenticated(Permission.ADMIN),
    settingsRoutes
  );
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

before(() => {
  app = createApp();
});

setupTestDb();

/** Which Client IDs were checked with Simkl; the check itself is stubbed. */
const validated: string[] = [];
const validateClientId = mock.method(
  SimklAPI.prototype,
  'validateClientId',
  async function (this: { clientId: string }) {
    validated.push(this.clientId);
  }
);

after(() => {
  validateClientId.mock.restore();
});

beforeEach(() => {
  validated.length = 0;
});

afterEach(() => {
  // Settings outlive this file; leave Simkl as a fresh install has it.
  getSettings().simkl = { enabled: true, clientId: '' } as never;
});

async function loginAsAdmin() {
  const settings = getSettings();
  settings.main.localLogin = true;
  settings.main.applicationUrl = 'http://localhost:5055';
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/local')
    .send({ email: 'admin@seerr.dev', password: 'test1234' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return agent;
}

async function linkSimklAccount() {
  const user = await getRepository(User).findOneOrFail({
    where: { email: 'admin@seerr.dev' },
  });
  const repository = getRepository(UserSettings);
  const settings =
    (await repository.findOne({ where: { user: { id: user.id } } })) ??
    repository.create({ user: { id: user.id } });
  Object.assign(settings, {
    simklAccessToken: 'simkl_at_linked',
    simklUserId: '4242',
  });
  await repository.save(settings);
}

const linkedCount = () =>
  getRepository(UserSettings)
    .createQueryBuilder('settings')
    .where('settings.simklUserId IS NOT NULL')
    .getCount();

describe('Simkl settings with the built-in app', () => {
  it('is on out of the box, with nothing to configure', async () => {
    const agent = await loginAsAdmin();
    const res = await agent.get('/api/v1/settings/simkl');
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.clientId, '');
    assert.equal(res.body.configured, true);
    assert.equal(getSettings().fullPublicSettings.simklConfigured, true);
  });

  it('turns off without disconnecting linked accounts', async () => {
    await linkSimklAccount();
    const agent = await loginAsAdmin();
    const res = await agent
      .post('/api/v1/settings/simkl')
      .send({ enabled: false, clientId: '' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.configured, false);
    assert.equal(getSettings().fullPublicSettings.simklConfigured, false);
    assert.equal(await linkedCount(), 1);
    assert.deepEqual(validated, []);
  });

  it('checks a custom Client ID, never the built-in one', async () => {
    const agent = await loginAsAdmin();
    await agent.post('/api/v1/settings/simkl').send({ clientId: '' });
    assert.deepEqual(validated, []);
    const res = await agent
      .post('/api/v1/settings/simkl')
      .send({ clientId: ' own-client ' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(validated, ['own-client']);
    assert.equal(getSettings().simkl.clientId, 'own-client');
  });

  it('asks before switching apps, either way', async () => {
    await linkSimklAccount();
    const agent = await loginAsAdmin();
    const toCustom = await agent
      .post('/api/v1/settings/simkl')
      .send({ clientId: 'own-client' });
    assert.equal(toCustom.status, 400);
    assert.equal(toCustom.body.linkedAccountCount, 1);

    getSettings().simkl = { ...getSettings().simkl, clientId: 'own-client' };
    const toBuiltin = await agent
      .post('/api/v1/settings/simkl')
      .send({ clientId: '', confirmDisconnectLinkedAccounts: true });
    assert.equal(toBuiltin.status, 200, JSON.stringify(toBuiltin.body));
    assert.equal(await linkedCount(), 0);
  });

  it('keeps links when the custom ID is just the built-in one', async () => {
    await linkSimklAccount();
    const agent = await loginAsAdmin();
    const res = await agent
      .post('/api/v1/settings/simkl')
      .send({ clientId: SIMKL_BUILTIN_CLIENT_ID });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await linkedCount(), 1);
  });
});
