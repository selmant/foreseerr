import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

const CONFIG_DIRECTORY = path.join(
  os.tmpdir(),
  `foreseerr-pack-test-${process.pid}`
);
process.env.CONFIG_DIRECTORY = CONFIG_DIRECTORY;

// Imported after CONFIG_DIRECTORY is set: PACK_DIRECTORY is resolved at load.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/consistent-type-imports */
const { fetchPack, PackFetchError, lastGoodPath, packPath } =
  require('@server/lib/mapping/packs/download') as typeof import('@server/lib/mapping/packs/download');
const { validatePackBody } =
  require('@server/lib/mapping/packs/formats') as typeof import('@server/lib/mapping/packs/formats');
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/consistent-type-imports */

const GOOD = JSON.stringify({ 'anidb:1': { 'tmdb_show:2': {} } });
const NEWER = JSON.stringify({ 'anidb:1': { 'tmdb_show:3': {} } });
const TRUNCATED = '{"anidb:1": {"tmdb_show:2": {';

interface Route {
  status: number;
  body?: string;
  etag?: string;
  /** Answer 304 when the request carries this If-None-Match value. */
  matchEtag?: string;
}

const routes = new Map<string, Route>();
const hits: string[] = [];
let server: Server;
let base = '';

before(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    hits.push(url);
    const route = routes.get(url);
    if (!route) {
      res.writeHead(404).end('missing');
      return;
    }
    if (route.matchEtag && req.headers['if-none-match'] === route.matchEtag) {
      res.writeHead(304, { etag: route.matchEtag }).end();
      return;
    }
    res
      .writeHead(route.status, {
        'content-type': 'application/json',
        ...(route.etag ? { etag: route.etag } : {}),
      })
      .end(route.body ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base =
    typeof address === 'object' && address
      ? `http://127.0.0.1:${address.port}`
      : '';
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fsp.rm(CONFIG_DIRECTORY, { recursive: true, force: true });
});

beforeEach(async () => {
  routes.clear();
  hits.length = 0;
  await fsp.rm(CONFIG_DIRECTORY, { recursive: true, force: true });
});

const validate = (body: string) => validatePackBody('json-graph', body);

describe('mapping pack download', () => {
  it('downloads from the first working mirror and records the etag', async () => {
    routes.set('/good.json', { status: 200, body: GOOD, etag: '"v1"' });
    const result = await fetchPack({
      key: 'test',
      format: 'json-graph',
      mirrors: [`${base}/good.json`],
      validate,
    });
    assert.equal(result.status, 'downloaded');
    assert.equal(result.body, GOOD);
    assert.equal(result.etag, '"v1"');
    assert.equal(
      await fsp.readFile(packPath('test', 'json-graph'), 'utf8'),
      GOOD
    );
  });

  it('falls through to the next mirror when the first is unreachable', async () => {
    routes.set('/mirror.json', { status: 200, body: GOOD });
    const result = await fetchPack({
      key: 'test',
      format: 'json-graph',
      mirrors: [`${base}/dead.json`, `${base}/mirror.json`],
      validate,
    });
    assert.equal(result.status, 'downloaded');
    assert.equal(result.mirror, `${base}/mirror.json`);
    assert.deepEqual(hits, ['/dead.json', '/mirror.json']);
  });

  it('sends If-None-Match and serves the local copy on 304', async () => {
    routes.set('/cond.json', { status: 200, body: GOOD, etag: '"v1"' });
    await fetchPack({
      key: 'test',
      format: 'json-graph',
      mirrors: [`${base}/cond.json`],
      validate,
    });

    routes.set('/cond.json', {
      status: 200,
      body: GOOD,
      etag: '"v1"',
      matchEtag: '"v1"',
    });
    const second = await fetchPack({
      key: 'test',
      format: 'json-graph',
      mirrors: [`${base}/cond.json`],
      cache: { etag: '"v1"' },
      validate,
    });
    assert.equal(second.status, 'notModified');
    assert.equal(second.body, GOOD);
  });

  it('leaves the live copy untouched when the download is truncated', async () => {
    routes.set('/pack.json', { status: 200, body: GOOD });
    await fetchPack({
      key: 'test',
      format: 'json-graph',
      mirrors: [`${base}/pack.json`],
      validate,
    });

    // The old downloader piped straight onto the live path, so a truncated
    // transfer corrupted the only copy and bricked anime mapping for 24 hours.
    routes.set('/pack.json', { status: 200, body: TRUNCATED });
    const result = await fetchPack({
      key: 'test',
      format: 'json-graph',
      mirrors: [`${base}/pack.json`],
      validate,
    });
    assert.equal(result.status, 'lastGood');
    assert.equal(result.body, GOOD);
    assert.equal(
      await fsp.readFile(packPath('test', 'json-graph'), 'utf8'),
      GOOD,
      'the live copy must survive a bad refresh'
    );
  });

  it('retains the previous copy as last-good after a successful refresh', async () => {
    routes.set('/pack.json', { status: 200, body: GOOD });
    await fetchPack({
      key: 'test',
      format: 'json-graph',
      mirrors: [`${base}/pack.json`],
      validate,
    });
    routes.set('/pack.json', { status: 200, body: NEWER });
    await fetchPack({
      key: 'test',
      format: 'json-graph',
      mirrors: [`${base}/pack.json`],
      validate,
    });

    assert.equal(
      await fsp.readFile(packPath('test', 'json-graph'), 'utf8'),
      NEWER
    );
    assert.equal(
      await fsp.readFile(lastGoodPath('test', 'json-graph'), 'utf8'),
      GOOD
    );
  });

  it('recovers from last-good when every mirror is dead', async () => {
    routes.set('/pack.json', { status: 200, body: GOOD });
    await fetchPack({
      key: 'test',
      format: 'json-graph',
      mirrors: [`${base}/pack.json`],
      validate,
    });

    const result = await fetchPack({
      key: 'test',
      format: 'json-graph',
      mirrors: [`${base}/gone.json`, `${base}/also-gone.json`],
      validate,
    });
    assert.equal(result.status, 'lastGood');
    assert.equal(result.body, GOOD);
  });

  it('reports every mirror attempt when there is nothing on disk', async () => {
    await assert.rejects(
      fetchPack({
        key: 'test',
        format: 'json-graph',
        mirrors: [`${base}/a.json`, `${base}/b.json`],
        validate,
      }),
      (error: unknown) => {
        assert.ok(error instanceof PackFetchError);
        assert.deepEqual(
          error.attempts.map((attempt) => attempt.mirror),
          [`${base}/a.json`, `${base}/b.json`]
        );
        return true;
      }
    );
  });

  it('rejects a 304 with no local copy rather than reporting success', async () => {
    routes.set('/pack.json', {
      status: 200,
      body: GOOD,
      matchEtag: '"stale"',
    });
    await assert.rejects(
      fetchPack({
        key: 'test',
        format: 'json-graph',
        mirrors: [`${base}/pack.json`],
        cache: { etag: '"stale"' },
        validate,
      })
    );
  });
});
