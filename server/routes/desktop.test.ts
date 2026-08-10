import JellyfinAPI, { type JellyfinUserResponse } from '@server/api/jellyfin';
import { ApiErrorCode } from '@server/constants/error';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import { Session } from '@server/entity/Session';
import { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import { setupTestDb } from '@server/test/db';
import { ApiError } from '@server/types/error';
import express, { type Express } from 'express';
import session from 'express-session';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import desktopRoutes from './desktop';

let app: Express;
let apiApp: Express;
const originalGetUser = JellyfinAPI.prototype.getUser;
const validLinkedIdentity = (): JellyfinUserResponse => ({
  Name: 'linked-user',
  ServerId: 'authoritative-server',
  ServerName: 'Jellyfin',
  Id: 'user-1',
  Configuration: { GroupedFolders: [] },
  Policy: { IsAdministrator: false },
});

function createApp(withCookieUser = true) {
  const instance = express();
  instance.use(express.json());
  instance.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
      genid: () => 'desktop-test-session',
    })
  );
  instance.use((req, _res, next) => {
    if (withCookieUser) req.session.userId = 1;
    next();
  });
  instance.use(checkUser);
  instance.use('/desktop', desktopRoutes);
  return instance;
}

before(async () => {
  JellyfinAPI.prototype.getUser = async () => validLinkedIdentity();
  app = createApp();
  apiApp = createApp(false);
});

after(() => {
  JellyfinAPI.prototype.getUser = originalGetUser;
});

setupTestDb();

beforeEach(async () => {
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.JELLYFIN;
  settings.jellyfin.serverId = 'server-1';
  settings.jellyfin.externalHostname = 'https://jellyfin.example.test';
  await getRepository(User)
    .createQueryBuilder()
    .update(User)
    .set({
      jellyfinUserId: 'user-1',
      jellyfinDeviceId: 'device-1',
      jellyfinAuthToken: 'secret-token',
    })
    .where('id = :id', { id: 1 })
    .execute();
  await getRepository(Session).save(
    Object.assign(new Session(), {
      id: 'desktop-test-session',
      expiredAt: Date.now() + 60_000,
      json: JSON.stringify({ userId: 1 }),
    })
  );
});

describe('desktop auth tickets', () => {
  it('issues and redeems a ticket once', async () => {
    const verifier = 'v'.repeat(43);
    const challenge = await import('node:crypto').then(({ createHash }) =>
      createHash('sha256').update(verifier).digest('hex')
    );
    const agent = request.agent(app);
    const issued = await agent
      .post('/desktop/auth-tickets')
      .send({ challenge, protocolVersion: 2 });

    assert.strictEqual(issued.status, 201);
    assert.strictEqual(issued.headers['cache-control'], 'no-store');
    const redeemed = await request(app)
      .post('/desktop/auth-tickets/redeem')
      .send({ ticket: issued.body.ticket, verifier, protocolVersion: 2 });

    assert.strictEqual(redeemed.status, 200);
    assert.strictEqual(redeemed.body.userId, 'user-1');
    assert.strictEqual(redeemed.body.serverId, 'authoritative-server');
    assert.strictEqual(redeemed.body.accessToken, 'secret-token');
    assert.strictEqual(redeemed.headers['cache-control'], 'no-store');

    const replay = await request(app)
      .post('/desktop/auth-tickets/redeem')
      .send({ ticket: issued.body.ticket, verifier, protocolVersion: 2 });
    assert.strictEqual(replay.status, 409);
    assert.strictEqual(replay.body.code, 'ticket_used');
  });

  it('rejects a wrong verifier without consuming the ticket', async () => {
    const verifier = 'a'.repeat(43);
    const challenge = await import('node:crypto').then(({ createHash }) =>
      createHash('sha256').update(verifier).digest('hex')
    );
    const issued = await request(app)
      .post('/desktop/auth-tickets')
      .send({ challenge, protocolVersion: 2 });

    const rejected = await request(app)
      .post('/desktop/auth-tickets/redeem')
      .send({
        ticket: issued.body.ticket,
        verifier: 'b'.repeat(43),
        protocolVersion: 2,
      });
    assert.strictEqual(rejected.status, 401);
    assert.strictEqual(rejected.body.code, 'invalid_verifier');
  });

  it('does not issue tickets to API-key authentication', async () => {
    const verifier = 'c'.repeat(43);
    const challenge = await import('node:crypto').then(({ createHash }) =>
      createHash('sha256').update(verifier).digest('hex')
    );
    const response = await request(apiApp)
      .post('/desktop/auth-tickets')
      .set('X-API-Key', getSettings().main.apiKey)
      .send({ challenge, protocolVersion: 2 });
    assert.strictEqual(response.status, 403);
    assert.strictEqual(response.body.code, 'session_required');
  });

  it('rejects redemption after the issuing session expires', async () => {
    const verifier = 'd'.repeat(43);
    const challenge = await import('node:crypto').then(({ createHash }) =>
      createHash('sha256').update(verifier).digest('hex')
    );
    const issued = await request(app)
      .post('/desktop/auth-tickets')
      .send({ challenge, protocolVersion: 2 });
    await getRepository(Session).delete({ id: 'desktop-test-session' });

    const response = await request(app)
      .post('/desktop/auth-tickets/redeem')
      .send({ ticket: issued.body.ticket, verifier, protocolVersion: 2 });
    assert.strictEqual(response.status, 401);
    assert.strictEqual(response.body.code, 'session_expired');
  });

  it('allows only one of two concurrent redemptions', async () => {
    const verifier = 'e'.repeat(43);
    const challenge = await import('node:crypto').then(({ createHash }) =>
      createHash('sha256').update(verifier).digest('hex')
    );
    const issued = await request(app)
      .post('/desktop/auth-tickets')
      .send({ challenge, protocolVersion: 2 });
    const responses = await Promise.all([
      request(app)
        .post('/desktop/auth-tickets/redeem')
        .send({ ticket: issued.body.ticket, verifier, protocolVersion: 2 }),
      request(app)
        .post('/desktop/auth-tickets/redeem')
        .send({ ticket: issued.body.ticket, verifier, protocolVersion: 2 }),
    ]);
    assert.deepStrictEqual(
      responses.map(({ status }) => status).sort(),
      [200, 409]
    );
  });

  it('uses the linked Jellyfin identity when cached serverId is empty', async () => {
    getSettings().jellyfin.serverId = '';
    const verifier = 'f'.repeat(43);
    const challenge = await import('node:crypto').then(({ createHash }) =>
      createHash('sha256').update(verifier).digest('hex')
    );
    const issued = await request(app)
      .post('/desktop/auth-tickets')
      .send({ challenge, protocolVersion: 2 });
    assert.strictEqual(issued.status, 201);

    const redeemed = await request(app)
      .post('/desktop/auth-tickets/redeem')
      .send({ ticket: issued.body.ticket, verifier, protocolVersion: 2 });
    assert.strictEqual(redeemed.status, 200);
    assert.strictEqual(redeemed.body.serverId, 'authoritative-server');
  });

  it('rejects an invalid linked Jellyfin token with a closed error', async () => {
    JellyfinAPI.prototype.getUser = async () => {
      throw new ApiError(401, ApiErrorCode.InvalidAuthToken);
    };
    try {
      const verifier = 'g'.repeat(43);
      const challenge = await import('node:crypto').then(({ createHash }) =>
        createHash('sha256').update(verifier).digest('hex')
      );
      const issued = await request(app)
        .post('/desktop/auth-tickets')
        .send({ challenge, protocolVersion: 2 });
      const redeemed = await request(app)
        .post('/desktop/auth-tickets/redeem')
        .send({ ticket: issued.body.ticket, verifier, protocolVersion: 2 });
      assert.strictEqual(redeemed.status, 401);
      assert.strictEqual(redeemed.body.code, 'token_invalid');
    } finally {
      JellyfinAPI.prototype.getUser = async () => validLinkedIdentity();
    }
  });

  it('rejects an HTTP Jellyfin bootstrap URL by default', async () => {
    getSettings().jellyfin.externalHostname = 'http://jellyfin.example.test';
    const verifier = 'h'.repeat(43);
    const challenge = await import('node:crypto').then(({ createHash }) =>
      createHash('sha256').update(verifier).digest('hex')
    );
    const issued = await request(app)
      .post('/desktop/auth-tickets')
      .send({ challenge, protocolVersion: 2 });
    assert.strictEqual(issued.status, 201);

    const redeemed = await request(app)
      .post('/desktop/auth-tickets/redeem')
      .send({ ticket: issued.body.ticket, verifier, protocolVersion: 2 });
    assert.strictEqual(redeemed.status, 500);
    assert.strictEqual(redeemed.body.accessToken, undefined);
  });
});
