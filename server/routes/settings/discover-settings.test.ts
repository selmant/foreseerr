import { DiscoverSliderType } from '@server/constants/discover';
import { getRepository } from '@server/datasource';
import DiscoverSlider from '@server/entity/DiscoverSlider';
import type { DiscoverSliderResponse } from '@server/interfaces/api/discoverInterfaces';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import routes from '@server/routes';
import { setupTestDb } from '@server/test/db';
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

before(() => {
  app = express();
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
    '/api',
    OpenApiValidator.middleware({
      apiSpec: API_SPEC_PATH,
      validateRequests: true,
    })
  );
  app.use(checkUser);
  app.use('/api/v1', routes);
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
});

setupTestDb();

async function loginAsAdmin() {
  const agent = request.agent(app);
  getSettings().main.localLogin = true;
  const res = await agent
    .post('/api/v1/auth/local')
    .send({ email: 'admin@seerr.dev', password: 'test1234' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return agent;
}

describe('GET /settings/discover slider contract', () => {
  it('describes sliders and never stores the computed fields', async () => {
    const repository = getRepository(DiscoverSlider);
    await repository.clear();
    await DiscoverSlider.bootstrapSliders();
    await repository.save(
      new DiscoverSlider({
        type: DiscoverSliderType.MDBLIST_LIST,
        title: 'Top Watched',
        data: 'https://mdblist.com/lists/linaspurinis/top-watched',
        isBuiltIn: false,
        enabled: true,
        order: 99,
      })
    );
    const agent = await loginAsAdmin();

    const res = await agent.get('/api/v1/settings/discover');
    assert.equal(res.status, 200);
    const sliders = res.body as DiscoverSliderResponse[];
    const byType = (type: DiscoverSliderType) =>
      sliders.find((slider) => slider.type === type);

    const trending = byType(DiscoverSliderType.TRENDING);
    assert.ok(trending);
    assert.equal(trending.endpoint, undefined);
    assert.equal(trending.defaultTitle, undefined);

    const planToWatch = byType(DiscoverSliderType.SIMKL_PLAN_TO_WATCH);
    assert.equal(
      planToWatch?.endpoint,
      '/api/v1/discover/simkl/library?status=plantowatch&hideUnmapped=true'
    );
    assert.equal(planToWatch?.defaultTitle, 'Simkl Plan to Watch');

    const list = byType(DiscoverSliderType.MDBLIST_LIST);
    assert.equal(
      list?.endpoint,
      '/api/v1/discover/mdblist/list?url=https%3A%2F%2Fmdblist.com%2Flists%2Flinaspurinis%2Ftop-watched&hideUnmapped=true'
    );
    assert.equal(list?.defaultTitle, undefined);

    // The Discover editor posts the sliders it received back as-is.
    const save = await agent
      .post('/api/v1/settings/discover')
      .send(
        sliders.map((slider) =>
          slider.id === list?.id
            ? { ...slider, endpoint: '/api/v1/elsewhere', defaultTitle: 'X' }
            : slider
        )
      );
    assert.equal(save.status, 200, JSON.stringify(save.body));

    const rows = await repository.query('SELECT * FROM "discover_slider"');
    for (const row of rows as Record<string, unknown>[]) {
      assert.equal('endpoint' in row, false);
      assert.equal('defaultTitle' in row, false);
    }

    const again = await agent.get('/api/v1/settings/discover');
    const listAgain = (again.body as DiscoverSliderResponse[]).find(
      (slider) => slider.id === list?.id
    );
    assert.equal(listAgain?.endpoint, list?.endpoint);
    assert.equal(listAgain?.title, 'Top Watched');
  });
});
