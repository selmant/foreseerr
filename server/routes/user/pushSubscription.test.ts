import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserPushSubscription } from '@server/entity/UserPushSubscription';
import { getSettings } from '@server/lib/settings';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import userRoutes from '@server/routes/user';
import { setupTestDb } from '@server/test/db';
import cookieParser from 'cookie-parser';
import express from 'express';
import session from 'express-session';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import request from 'supertest';

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
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use('/user', isAuthenticated(), userRoutes);
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

async function authenticatedAgent() {
  const agent = request.agent(app);
  getSettings().main.localLogin = true;
  const response = await agent
    .post('/auth/local')
    .send({ email: 'admin@seerr.dev', password: 'test1234' });
  assert.equal(response.status, 200);
  return agent;
}

describe('POST /user/registerPushSubscription', () => {
  it('keeps two devices that only share a user agent', async () => {
    const agent = await authenticatedAgent();
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    const userAgent = 'Mozilla/5.0 shared-browser';

    const first = await agent.post('/user/registerPushSubscription').send({
      endpoint: 'https://push.example/device-a',
      p256dh: 'p256dh-a',
      auth: 'auth-device-a',
      userAgent,
    });
    const second = await agent.post('/user/registerPushSubscription').send({
      endpoint: 'https://push.example/device-b',
      p256dh: 'p256dh-b',
      auth: 'auth-device-b',
      userAgent,
    });

    assert.equal(first.status, 204);
    assert.equal(second.status, 204);

    const stored = await getRepository(UserPushSubscription).find({
      where: { user: { id: user.id } },
    });
    assert.equal(stored.length, 2);
  });

  it('replaces a rotated endpoint that keeps the same auth key', async () => {
    const agent = await authenticatedAgent();
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    await agent.post('/user/registerPushSubscription').send({
      endpoint: 'https://push.example/old',
      p256dh: 'p256dh-old',
      auth: 'auth-rotated',
      userAgent: 'Mozilla/5.0 iPhone',
    });
    const rotated = await agent.post('/user/registerPushSubscription').send({
      endpoint: 'https://push.example/new',
      p256dh: 'p256dh-new',
      auth: 'auth-rotated',
      userAgent: 'Mozilla/5.0 iPhone',
    });

    assert.equal(rotated.status, 204);

    const stored = await getRepository(UserPushSubscription).find({
      where: { user: { id: user.id }, auth: 'auth-rotated' },
    });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].endpoint, 'https://push.example/new');
  });
});
