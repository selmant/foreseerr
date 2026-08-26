import assert from 'node:assert/strict';
import { afterEach, before, describe, it, mock } from 'node:test';

import ServarrBase from '@server/api/servarr/base';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { ServarrIntervention } from '@server/entity/ServarrIntervention';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { getSettings, type RadarrSettings } from '@server/lib/settings';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import servarrInterventionRoutes from '@server/routes/servarrInterventions';
import settingsRoutes from '@server/routes/settings';
import { setupTestDb } from '@server/test/db';
import cookieParser from 'cookie-parser';
import type { Express } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import session from 'express-session';
import { join } from 'node:path';
import request from 'supertest';
import authRoutes from './auth';

const API_SPEC_PATH = join(__dirname, '../../seerr-api.yml');

const server: RadarrSettings = {
  id: 7,
  name: 'Radarr Test',
  hostname: 'localhost',
  port: 7878,
  apiKey: 'secret',
  useSsl: false,
  activeProfileId: 1,
  activeProfileName: 'Any',
  activeDirectory: '/movies',
  tags: [],
  is4k: false,
  isDefault: true,
  syncEnabled: true,
  preventSearch: false,
  tagRequests: false,
  overrideRule: [],
  minimumAvailability: 'released',
};

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
      validateSecurity: false,
    })
  );
  app.use(checkUser);
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/servarr/interventions', servarrInterventionRoutes);
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
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message });
    }
  );
  return app;
}

setupTestDb();

before(async () => {
  app = createApp();
});

afterEach(() => {
  mock.restoreAll();
  getSettings().radarr = [];
  getSettings().servarrInterventions = {
    automaticCleanupEnabled: false,
    cleanupGraceHours: 24,
  };
});

async function loginAs(email: string) {
  const settings = getSettings();
  const prior = settings.main.localLogin;
  settings.main.localLogin = true;
  try {
    const agent = request.agent(app);
    const res = await agent
      .post('/api/v1/auth/local')
      .send({ email, password: 'test1234' });
    assert.equal(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = prior;
  }
}

async function loginManager() {
  const user = await getRepository(User).findOneByOrFail({
    email: 'friend@seerr.dev',
  });
  user.permissions = Permission.MANAGE_REQUESTS;
  await getRepository(User).save(user);
  return loginAs('friend@seerr.dev');
}

async function seedIntervention(overrides: Partial<ServarrIntervention> = {}) {
  const media = await getRepository(Media).save(
    new Media({
      tmdbId: 5001,
      mediaType: MediaType.MOVIE,
      status: MediaStatus.UNKNOWN,
      status4k: MediaStatus.UNKNOWN,
      serviceId: server.id,
      externalServiceId: 1001,
    })
  );
  const firstSeenAt = new Date('2026-08-26T10:00:00.000Z');
  return getRepository(ServarrIntervention).save(
    new ServarrIntervention({
      serviceType: 'radarr',
      serviceId: server.id,
      serviceName: server.name,
      is4k: false,
      queueId: 99,
      downloadId: 'private-download-id',
      outputPath: '/private/path',
      externalServiceId: 1001,
      mediaId: media.id,
      tmdbId: media.tmdbId,
      mediaType: media.mediaType,
      releaseTitle: 'Example.Release.1080p',
      warningMessages: ['No files found'],
      manualImportCapable: true,
      state: 'active',
      firstSeenAt,
      cleanupDeadlineAt: new Date(firstSeenAt.getTime() + 24 * 60 * 60 * 1000),
      ...overrides,
    })
  );
}

describe('Servarr intervention routes', () => {
  it('requires MANAGE_REQUESTS for the inbox', async () => {
    const agent = await loginAs('friend@seerr.dev');
    const response = await agent.get('/api/v1/servarr/interventions');
    assert.equal(response.status, 403);
  });

  it('lists active warnings without leaking Arr identities', async () => {
    await seedIntervention();
    const agent = await loginManager();
    const response = await agent.get(
      '/api/v1/servarr/interventions?mode=active'
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.pageInfo.results, 1);
    assert.equal(
      response.body.results[0].releaseTitle,
      'Example.Release.1080p'
    );
    assert.equal(response.body.results[0].queueId, undefined);
    assert.equal(response.body.results[0].downloadId, undefined);
    assert.equal(response.body.results[0].outputPath, undefined);
  });

  it('lists only successful Foreseerr blocklist history', async () => {
    await seedIntervention({
      queueId: 1,
      state: 'resolved',
      resolution: 'manual_blocklist',
      actedByUserId: 1,
      resolvedAt: new Date('2026-08-26T12:00:00.000Z'),
    });
    await seedIntervention({
      queueId: 2,
      state: 'resolved',
      resolution: 'recovered',
      resolvedAt: new Date('2026-08-26T12:00:00.000Z'),
    });
    const agent = await loginManager();
    const response = await agent.get(
      '/api/v1/servarr/interventions?mode=history'
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.pageInfo.results, 1);
    assert.equal(response.body.results[0].resolution, 'manual_blocklist');
    assert.equal(response.body.results[0].actor.displayName, 'admin');
  });

  it('counts unseen items independently per manager', async () => {
    await seedIntervention();
    const first = await loginManager();
    const unseen = await first.get('/api/v1/servarr/interventions/count');
    assert.equal(unseen.body.active, 1);
    assert.equal(unseen.body.unseen, 1);

    const seen = await first.post('/api/v1/servarr/interventions/seen');
    assert.equal(seen.status, 200);
    const afterSeen = await first.get('/api/v1/servarr/interventions/count');
    assert.equal(afterSeen.body.unseen, 0);

    const admin = await loginAs('admin@seerr.dev');
    const adminCount = await admin.get('/api/v1/servarr/interventions/count');
    assert.equal(adminCount.body.unseen, 1);
  });

  it('rejects an active warning for a manager', async () => {
    getSettings().radarr = [server];
    const record = await seedIntervention();
    mock.method(ServarrBase.prototype, 'getQueue', async () => [
      {
        id: 99,
        movieId: 1001,
        title: 'Example.Release.1080p',
        status: 'completed',
        trackedDownloadStatus: 'warning',
        downloadId: 'private-download-id',
        outputPath: '/private/path',
        statusMessages: [],
      },
    ]);
    mock.method(
      ServarrBase.prototype,
      'removeQueueItem',
      async () => undefined
    );
    const agent = await loginManager();
    const response = await agent.post(
      `/api/v1/servarr/interventions/${record.id}/reject`
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.resolution, 'manual_blocklist');
    assert.equal(response.body.downloadId, undefined);
  });

  it('rejects invalid list filters', async () => {
    const agent = await loginManager();
    const response = await agent.get('/api/v1/servarr/interventions?mode=nope');
    assert.equal(response.status, 400);
  });
});

describe('Servarr intervention settings', () => {
  it('keeps cleanup settings admin-only and validates the grace period', async () => {
    const manager = await loginManager();
    assert.equal(
      (await manager.get('/api/v1/settings/servarr-interventions')).status,
      403
    );

    const admin = await loginAs('admin@seerr.dev');
    const invalid = await admin
      .post('/api/v1/settings/servarr-interventions')
      .send({ automaticCleanupEnabled: true, cleanupGraceHours: 0 });
    assert.equal(invalid.status, 400);

    const saved = await admin
      .post('/api/v1/settings/servarr-interventions')
      .send({ automaticCleanupEnabled: true, cleanupGraceHours: 48 });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, {
      automaticCleanupEnabled: true,
      cleanupGraceHours: 48,
    });
  });
});
