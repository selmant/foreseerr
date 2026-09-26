import express, { type ErrorRequestHandler } from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import {
  isLoopbackAddress,
  isPluginMode,
  pluginApiSpec,
  pluginCookiePath,
  pluginIndexHtml,
  pluginPublicBasePath,
  requirePluginProxy,
} from './pluginMode';

describe('pluginMode', () => {
  it('treats FORESEERR_PLUGIN=1 as plugin mode with /Foreseerr base', () => {
    const previousPlugin = process.env.FORESEERR_PLUGIN;
    const previousBase = process.env.FORESEERR_BASE_PATH;
    process.env.FORESEERR_PLUGIN = '1';
    delete process.env.FORESEERR_BASE_PATH;
    try {
      assert.equal(isPluginMode(), true);
      assert.equal(pluginPublicBasePath(), '/Foreseerr');
      assert.equal(pluginCookiePath(), '/Foreseerr');
    } finally {
      if (previousPlugin === undefined) delete process.env.FORESEERR_PLUGIN;
      else process.env.FORESEERR_PLUGIN = previousPlugin;
      if (previousBase === undefined) delete process.env.FORESEERR_BASE_PATH;
      else process.env.FORESEERR_BASE_PATH = previousBase;
    }
  });

  it('recognizes loopback addresses', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackAddress('::1'), true);
    assert.equal(isLoopbackAddress('192.168.1.5'), false);
  });

  it('writes the Jellyfin subpath into index.html and rejects markup', () => {
    const previous = process.env.FORESEERR_PUBLIC_BASE_PATH;
    const html = '<html><head><link rel="manifest" href="/m"></head></html>';
    try {
      process.env.FORESEERR_PUBLIC_BASE_PATH = '/media.server/Foreseerr';
      assert.equal(
        pluginIndexHtml(html),
        '<html><head><base href="/media.server/Foreseerr/"><meta name="foreseerr-base-path" content="/media.server/Foreseerr"></head></html>'
      );
      for (const invalid of ['//evil.test', '/a"><script>', '/a b']) {
        process.env.FORESEERR_PUBLIC_BASE_PATH = invalid;
        assert.throws(() => pluginIndexHtml(html));
      }
    } finally {
      if (previous === undefined) delete process.env.FORESEERR_PUBLIC_BASE_PATH;
      else process.env.FORESEERR_PUBLIC_BASE_PATH = previous;
    }
  });
});

describe('plugin proxy boundary', () => {
  const previousPlugin = process.env.FORESEERR_PLUGIN;
  const previousSecret = process.env.FORESEERR_PLUGIN_SECRET;
  beforeEach(() => {
    process.env.FORESEERR_PLUGIN = '1';
    process.env.FORESEERR_PLUGIN_SECRET = 'proxy-test-secret';
  });
  afterEach(() => {
    if (previousPlugin === undefined) delete process.env.FORESEERR_PLUGIN;
    else process.env.FORESEERR_PLUGIN = previousPlugin;
    if (previousSecret === undefined)
      delete process.env.FORESEERR_PLUGIN_SECRET;
    else process.env.FORESEERR_PLUGIN_SECRET = previousSecret;
  });
  const app = express();
  app.enable('trust proxy');
  app.use(requirePluginProxy);
  app.get('/api/v1/status', (_req, res) => res.json({ ok: true }));

  it('requires the plugin secret even on loopback and health routes', async () => {
    assert.equal((await request(app).get('/api/v1/status')).status, 403);
    assert.equal(
      (
        await request(app)
          .get('/api/v1/status')
          .set('X-Forwarded-For', '127.0.0.1')
          .set('X-Foreseerr-Plugin-Secret', 'incorrect')
      ).status,
      403
    );
    assert.equal(
      (
        await request(app)
          .get('/api/v1/status')
          .set('X-Foreseerr-Plugin-Secret', 'proxy-test-secret')
      ).status,
      200
    );
  });

  it('fails closed when the plugin secret is missing', async () => {
    delete process.env.FORESEERR_PLUGIN_SECRET;
    assert.equal((await request(app).get('/api/v1/status')).status, 403);
  });

  it('preserves standalone requests', async () => {
    delete process.env.FORESEERR_PLUGIN;
    assert.equal((await request(app).get('/api/v1/status')).status, 200);
  });

  it('keeps API validation and query rewriting working under the mount', async () => {
    const previousBase = process.env.FORESEERR_BASE_PATH;
    delete process.env.FORESEERR_BASE_PATH;
    try {
      const spec = {
        openapi: '3.0.2',
        info: { title: 'plugin', version: '1' },
        servers: [
          {
            url: '{server}/api/v1',
            variables: { server: { default: 'http://localhost:5055' } },
          },
        ],
        paths: {
          '/items': {
            get: {
              parameters: [
                { name: 'page', in: 'query', schema: { type: 'integer' } },
              ],
              responses: { '200': { description: 'ok' } },
            },
          },
        },
      };
      const inner = express();
      inner.use(
        '/api',
        OpenApiValidator.middleware({
          apiSpec: pluginApiSpec(spec) as Parameters<
            typeof OpenApiValidator.middleware
          >[0]['apiSpec'],
          validateRequests: true,
        })
      );
      // Mirrors the Discover defaults middleware, which replaces req.query.
      inner.get('/api/v1/items', (req, res) => {
        req.query = { ...req.query, sort: 'default' };
        res.json(req.query);
      });
      const errors: ErrorRequestHandler = (
        error,
        _req,
        res,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _next
      ) => {
        res.status(error.status ?? 500).json({ message: error.message });
      };
      inner.use(errors);
      const app = express();
      app.use('/Foreseerr', inner);

      const ok = await request(app).get('/Foreseerr/api/v1/items?page=2');
      assert.equal(ok.status, 200, ok.text);
      assert.deepEqual(ok.body, { page: 2, sort: 'default' });
      assert.equal(
        (await request(app).get('/Foreseerr/api/v1/items?page=x')).status,
        400
      );
    } finally {
      if (previousBase === undefined) delete process.env.FORESEERR_BASE_PATH;
      else process.env.FORESEERR_BASE_PATH = previousBase;
    }
  });
});
