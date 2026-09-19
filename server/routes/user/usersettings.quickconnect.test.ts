import JellyfinAPI from '@server/api/jellyfin';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';
import request from 'supertest';
import userRoutes from '.';

const authenticateQCMock = mock.method(
  JellyfinAPI.prototype,
  'authenticateQuickConnect',
  async () => ({
    User: {
      Id: 'jf-link-user-001',
      Name: 'linkeduser',
      ServerId: 'server-1',
      Policy: { IsAdministrator: false },
    },
    AccessToken: 'fake-qc-access-token',
  })
);

let app: Express;

before(() => {
  app = express();
  app.use(express.json());
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
    ) => res.status(err.status ?? 500).json({ message: err.message })
  );
});

setupTestDb();

async function loginAsFriend() {
  getSettings().main.localLogin = true;
  const agent = request.agent(app);
  const res = await agent
    .post('/auth/local')
    .send({ email: 'friend@seerr.dev', password: 'test1234' });
  assert.strictEqual(res.status, 200);
  return { agent, userId: res.body.id as number };
}

describe('POST /user/:id/settings/linked-accounts/jellyfin/quickconnect', () => {
  beforeEach(() => {
    authenticateQCMock.mock.resetCalls();
    getSettings().main.mediaServerType = MediaServerType.JELLYFIN;
  });

  it('links the account for Jellyfin', async () => {
    const { agent, userId } = await loginAsFriend();

    const res = await agent
      .post(`/user/${userId}/settings/linked-accounts/jellyfin/quickconnect`)
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 204, JSON.stringify(res.body));
    assert.strictEqual(authenticateQCMock.mock.callCount(), 1);

    const user = await getRepository(User).findOneOrFail({
      where: { id: userId },
    });
    assert.strictEqual(user.jellyfinUserId, 'jf-link-user-001');
    assert.strictEqual(user.userType, UserType.JELLYFIN);
  });

  it('rejects Emby before calling the Quick Connect API', async () => {
    const { agent, userId } = await loginAsFriend();
    getSettings().main.mediaServerType = MediaServerType.EMBY;

    const res = await agent
      .post(`/user/${userId}/settings/linked-accounts/jellyfin/quickconnect`)
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(authenticateQCMock.mock.callCount(), 0);

    const user = await getRepository(User).findOneOrFail({
      where: { id: userId },
    });
    assert.strictEqual(user.jellyfinUserId, null);
  });
});
