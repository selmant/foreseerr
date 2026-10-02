import { datasetTmdb } from '@server/lib/mapping/edges';
import { recordMiss } from '@server/lib/mapping/resolutions';
import { resolveTmdb } from '@server/lib/mapping/resolve';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import settingsRoutes from '@server/routes/settings';
import { setupTestDb } from '@server/test/db';
import { edge, seedEdges } from '@server/test/mapping';
import cookieParser from 'cookie-parser';
import type { Express } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import session from 'express-session';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
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

const sighting = (id: string, title: string, times: number) => {
  for (let i = 0; i < times; i++) {
    recordMiss({
      ref: { ns: 'simkl', id },
      mediaType: 'tv',
      title,
      discoverSource: 'simkl/trending/anime',
    });
  }
};

describe('mapping settings API', () => {
  it('reports datasets and counts in the documented shape', async () => {
    const agent = await loginAsAdmin();
    sighting('2419656', 'Ore dake Level Up na Ken', 7);
    await seedEdges(edge('anilist:1', 'tmdb_show:10:s1'));

    const res = await agent.get('/api/v1/settings/mapping/status');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.counts, { unmapped: 1, manual: 0, guessed: 0 });
    assert.deepEqual(
      res.body.datasets.map(
        (dataset: {
          key: string;
          enabled: boolean;
          edgeCount: number | null;
        }) => [dataset.key, dataset.enabled, dataset.edgeCount]
      ),
      [
        ['anibridge', true, 1],
        ['fribb', true, null],
      ]
    );
    assert.equal(res.body.datasets[1].licence, 'none');
  });

  it('lists unmapped items most-seen first', async () => {
    const agent = await loginAsAdmin();
    sighting('1', 'Seen once', 1);
    sighting('2', 'Seen often', 5);

    const res = await agent.get(
      '/api/v1/settings/mapping/resolutions?list=unmapped'
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.total, 2);
    assert.deepEqual(
      res.body.results.map((row: { title: string; hitCount: number }) => [
        row.title,
        row.hitCount,
      ]),
      [
        ['Seen often', 5],
        ['Seen once', 1],
      ]
    );
  });

  it('rejects a list it does not know', async () => {
    const agent = await loginAsAdmin();
    const res = await agent.get(
      '/api/v1/settings/mapping/resolutions?list=gaps'
    );
    assert.equal(res.status, 400);
  });

  it('stores a correction that the resolver then answers with', async () => {
    const agent = await loginAsAdmin();
    sighting('2419656', 'Ore dake Level Up na Ken', 3);

    const res = await agent.post('/api/v1/settings/mapping/corrections').send({
      srcNs: 'simkl',
      srcId: '2419656',
      tmdbId: 127532,
      tmdbType: 'tv',
      note: 'Solo Leveling',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    assert.deepEqual(
      await resolveTmdb({
        refs: [{ ns: 'simkl', id: '2419656' }],
        mediaType: 'tv',
      }),
      { tmdbId: 127532, mediaType: 'tv', origin: 'manual' }
    );
    const unmapped = await agent.get(
      '/api/v1/settings/mapping/resolutions?list=unmapped'
    );
    assert.equal(
      unmapped.body.total,
      0,
      'a corrected item is no longer unmapped'
    );
    const manual = await agent.get(
      '/api/v1/settings/mapping/resolutions?list=manual'
    );
    assert.equal(manual.body.results[0].detail, 'Solo Leveling');
  });

  it('records an absence when the TMDB id is left out', async () => {
    const agent = await loginAsAdmin();
    await seedEdges(edge('anilist:5', 'tmdb_show:50:s1'));

    const res = await agent
      .post('/api/v1/settings/mapping/corrections')
      .send({ srcNs: 'anilist', srcId: '5' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(
      await resolveTmdb({
        refs: [{ ns: 'anilist', id: '5' }],
        mediaType: 'tv',
      }),
      undefined,
      'the correction wins over the dataset'
    );
  });

  it('rejects a correction that cannot be stored as written', async () => {
    const agent = await loginAsAdmin();
    for (const body of [
      { srcNs: 'kitsu', srcId: '1', tmdbId: 1, tmdbType: 'tv' },
      { srcNs: 'anilist', tmdbId: 1, tmdbType: 'tv' },
      // An id with no type could land in either TMDB catalogue.
      { srcNs: 'anilist', srcId: '1', tmdbId: 1 },
    ]) {
      const res = await agent
        .post('/api/v1/settings/mapping/corrections')
        .send(body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });

  it('rejects an id that is not a positive whole number rather than hiding the title', async () => {
    const agent = await loginAsAdmin();
    for (const tmdbId of [0, -5, 1.5, '12abc']) {
      const res = await agent
        .post('/api/v1/settings/mapping/corrections')
        .send({ srcNs: 'anilist', srcId: '7', tmdbId, tmdbType: 'tv' });
      assert.equal(res.status, 400, `tmdbId ${tmdbId}`);
    }
    const manual = await agent.get(
      '/api/v1/settings/mapping/resolutions?list=manual'
    );
    assert.equal(manual.body.total, 0);
  });

  it('round-trips a "no TMDB entry" correction and its note through export', async () => {
    const agent = await loginAsAdmin();
    await agent
      .post('/api/v1/settings/mapping/corrections')
      .send({ srcNs: 'anilist', srcId: '9', note: 'music video' });
    const exported = await agent.get(
      '/api/v1/settings/mapping/resolutions?list=manual'
    );
    await agent.delete(
      `/api/v1/settings/mapping/resolutions/${exported.body.results[0].id}`
    );

    const res = await agent
      .post('/api/v1/settings/mapping/corrections/import')
      .send({ corrections: exported.body.results });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { imported: 1, skipped: 0 });
    const [row] = (
      await agent.get('/api/v1/settings/mapping/resolutions?list=manual')
    ).body.results;
    assert.deepEqual(
      [row.srcId, row.tmdbId, row.detail],
      ['9', null, 'music video']
    );
  });

  it('undoes a correction when its row is deleted', async () => {
    const agent = await loginAsAdmin();
    await seedEdges(edge('anilist:5', 'tmdb_show:50:s1'));
    await agent
      .post('/api/v1/settings/mapping/corrections')
      .send({ srcNs: 'anilist', srcId: '5', tmdbId: 999, tmdbType: 'tv' });
    const manual = await agent.get(
      '/api/v1/settings/mapping/resolutions?list=manual'
    );

    const res = await agent.delete(
      `/api/v1/settings/mapping/resolutions/${manual.body.results[0].id}`
    );
    assert.equal(res.status, 204);
    assert.equal(
      (
        await resolveTmdb({
          refs: [{ ns: 'anilist', id: '5' }],
          mediaType: 'tv',
        })
      )?.tmdbId,
      50
    );
  });

  it('round-trips an export through import', async () => {
    const agent = await loginAsAdmin();
    await agent
      .post('/api/v1/settings/mapping/corrections')
      .send({ srcNs: 'anilist', srcId: '5', tmdbId: 999, tmdbType: 'tv' });
    const exported = await agent.get(
      '/api/v1/settings/mapping/resolutions?list=manual'
    );
    await agent.delete(
      `/api/v1/settings/mapping/resolutions/${exported.body.results[0].id}`
    );

    const res = await agent
      .post('/api/v1/settings/mapping/corrections/import')
      .send({ corrections: exported.body.results });
    assert.deepEqual(res.body, { imported: 1, skipped: 0 });
    assert.equal(
      (
        await resolveTmdb({
          refs: [{ ns: 'anilist', id: '5' }],
          mediaType: 'tv',
        })
      )?.tmdbId,
      999
    );
  });

  it('imports overrides exported before the mapping rebuild', async () => {
    const agent = await loginAsAdmin();
    const res = await agent
      .post('/api/v1/settings/mapping/corrections/import')
      .send({
        corrections: [
          {
            fromNamespace: 'anilist',
            fromExternalId: '21',
            fromSeason: -1,
            toNamespace: 'tmdb_show',
            toExternalId: '37854',
            note: 'One Piece',
          },
          {
            fromNamespace: 'trakt',
            fromExternalId: 'gone',
            toNamespace: 'tmdb_movie',
            toExternalId: '',
          },
          // Aimed at TVDB: there is nothing to turn this into.
          {
            fromNamespace: 'anilist',
            fromExternalId: '1',
            toNamespace: 'tvdb_show',
            toExternalId: '5',
          },
        ],
      });
    assert.deepEqual(res.body, { imported: 2, skipped: 1 });
    assert.deepEqual(
      await resolveTmdb({
        refs: [{ ns: 'anilist', id: '21' }],
        mediaType: 'tv',
      }),
      { tmdbId: 37854, mediaType: 'tv', origin: 'manual' }
    );
  });

  it('disables a dataset, removing its answers', async () => {
    const agent = await loginAsAdmin();
    await seedEdges(edge('anilist:2', 'tmdb_show:20:s1'), 'fribb');
    assert.equal(
      (await datasetTmdb({ ns: 'anilist', id: '2' }, 'tv'))?.tmdbId,
      20
    );

    const res = await agent
      .post('/api/v1/settings/mapping/datasets/fribb')
      .send({ enabled: false });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.enabled, false);
    assert.equal(
      await datasetTmdb({ ns: 'anilist', id: '2' }, 'tv'),
      undefined
    );
  });

  it('refuses a dataset it does not know', async () => {
    const agent = await loginAsAdmin();
    assert.equal(
      (
        await agent
          .post('/api/v1/settings/mapping/datasets/animeapi')
          .send({ enabled: true })
      ).status,
      404
    );
    assert.equal(
      (await agent.post('/api/v1/settings/mapping/datasets/animeapi/refresh'))
        .status,
      404
    );
  });

  it('requires an authenticated admin', async () => {
    const res = await request(app).get('/api/v1/settings/mapping/status');
    assert.equal(res.status, 401);
  });
});
