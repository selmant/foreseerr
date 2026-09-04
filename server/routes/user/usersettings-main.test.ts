import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import userRoutes from '@server/routes/user';
import { setupTestDb } from '@server/test/db';
import cookieParser from 'cookie-parser';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import session from 'express-session';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import request from 'supertest';

const API_SPEC_PATH = join(__dirname, '../../../seerr-api.yml');
const app = express();

before(() => {
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
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => res.status(err.status || 500).json({ message: err.message })
  );
});

setupTestDb();

async function authenticatedAgent(email: string) {
  const agent = request.agent(app);
  getSettings().main.localLogin = true;
  const response = await agent
    .post('/api/v1/auth/local')
    .send({ email, password: 'test1234' });
  assert.equal(response.status, 200);
  return agent;
}

describe('user general settings skipped episode preference', () => {
  it('defaults to disabled and round-trips true and false', async () => {
    const agent = await authenticatedAgent('admin@seerr.dev');
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    const initial = await agent.get(`/api/v1/user/${user.id}/settings/main`);
    assert.equal(initial.status, 200);
    assert.notEqual(initial.body.autoCompleteSkippedEpisodeEndings, true);
    assert.equal(initial.body.autoCompleteSkippedEpisodeThreshold, 50);

    for (const value of [true, false]) {
      const updated = await agent
        .post(`/api/v1/user/${user.id}/settings/main`)
        .send({
          username: user.username,
          email: user.email,
          autoCompleteSkippedEpisodeEndings: value,
        });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
      assert.equal(updated.body.autoCompleteSkippedEpisodeEndings, value);
    }
  });

  it('preserves an existing value when an older client omits the field', async () => {
    const agent = await authenticatedAgent('admin@seerr.dev');
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
      relations: { settings: true },
    });
    const settings = user.settings ?? new UserSettings({ user });
    settings.autoCompleteSkippedEpisodeEndings = true;
    await getRepository(UserSettings).save(settings);

    const response = await agent
      .post(`/api/v1/user/${user.id}/settings/main`)
      .send({ username: user.username, email: user.email });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.autoCompleteSkippedEpisodeEndings, true);
  });

  it('round-trips a leftover progress threshold and preserves it when omitted', async () => {
    const agent = await authenticatedAgent('admin@seerr.dev');
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
      relations: { settings: true },
    });
    const updated = await agent
      .post(`/api/v1/user/${user.id}/settings/main`)
      .send({
        username: user.username,
        email: user.email,
        autoCompleteSkippedEpisodeEndings: true,
        autoCompleteSkippedEpisodeThreshold: 80,
      });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.autoCompleteSkippedEpisodeThreshold, 80);

    const omitted = await agent
      .post(`/api/v1/user/${user.id}/settings/main`)
      .send({ username: user.username, email: user.email });
    assert.equal(omitted.status, 200, JSON.stringify(omitted.body));
    assert.equal(omitted.body.autoCompleteSkippedEpisodeThreshold, 80);
  });

  it('round-trips a watch-ahead default and preserves it when omitted', async () => {
    const agent = await authenticatedAgent('admin@seerr.dev');
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    const initial = await agent.get(`/api/v1/user/${user.id}/settings/main`);
    assert.equal(initial.status, 200);
    assert.equal(initial.body.watchAheadEpisodeCount, 10);

    const updated = await agent
      .post(`/api/v1/user/${user.id}/settings/main`)
      .send({
        username: user.username,
        email: user.email,
        watchAheadEpisodeCount: 20,
      });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.watchAheadEpisodeCount, 20);

    const omitted = await agent
      .post(`/api/v1/user/${user.id}/settings/main`)
      .send({ username: user.username, email: user.email });
    assert.equal(omitted.status, 200, JSON.stringify(omitted.body));
    assert.equal(omitted.body.watchAheadEpisodeCount, 20);
  });

  it('keeps existing profile authorization rules', async () => {
    const friend = await getRepository(User).findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });
    const unauthenticated = await request(app).get(
      `/api/v1/user/${friend.id}/settings/main`
    );
    assert.equal(unauthenticated.status, 401);
  });
});
