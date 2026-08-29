import { getRepository } from '@server/datasource';
import { MappingCluster } from '@server/entity/MappingCluster';
import { MappingLink } from '@server/entity/MappingLink';
import { MappingSource } from '@server/entity/MappingSource';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

const CONFIG_DIRECTORY = path.join(
  os.tmpdir(),
  `foreseerr-retract-test-${process.pid}`
);
process.env.CONFIG_DIRECTORY = CONFIG_DIRECTORY;

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/consistent-type-imports */
const { refreshPack } =
  require('@server/lib/mapping/packs') as typeof import('@server/lib/mapping/packs');
const { upsertCluster } =
  require('@server/lib/mapping/graph') as typeof import('@server/lib/mapping/graph');
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/consistent-type-imports */

setupTestDb();

const BODY = JSON.stringify({ 'anilist:1': { 'tmdb_show:111': {} } });
let payload = BODY;

const entry = {
  key: 'anibridge',
  format: 'json-graph' as const,
  mirrors: [] as string[],
  enabled: true,
  priority: 10,
  trust: 90,
};

let server: Server;
let base = '';
const etag = '"v1"';
let notModified = false;

before(async () => {
  server = createServer((req, res) => {
    if (notModified && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag }).end();
      return;
    }
    res
      .writeHead(200, {
        'content-type': 'application/json',
        etag,
        'content-length': Buffer.byteLength(payload),
      })
      .end(payload);
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
  notModified = false;
  payload = BODY;
  await fsp.rm(CONFIG_DIRECTORY, { recursive: true, force: true });
  await getRepository(MappingLink).clear();
  await getRepository(MappingCluster).clear();
  await getRepository(MappingSource).clear();
});

describe('pack refresh retract', () => {
  it('does not retract on a 304 when replacePackGraph is off', async () => {
    entry.mirrors = [`${base}/pack.json`];
    const first = await refreshPack(entry, { ingest: true });
    assert.equal(first.status, 'downloaded');

    await upsertCluster([
      {
        ref: { ns: 'simkl', id: '9' },
        confidence: 80,
        sourceKey: 'simkl-live',
      },
      {
        ref: { ns: 'tmdb_show', id: '111' },
        confidence: 80,
        sourceKey: 'simkl-live',
      },
    ]);

    const packLinks = await getRepository(MappingLink).count({
      where: { sourceKey: 'anibridge' },
    });
    assert.ok(packLinks >= 1);

    notModified = true;
    const second = await refreshPack(entry, { ingest: true });
    assert.equal(second.status, 'notModified');

    assert.equal(
      await getRepository(MappingLink).count({
        where: { sourceKey: 'anibridge' },
      }),
      packLinks
    );
    assert.equal(
      await getRepository(MappingLink).count({
        where: { sourceKey: 'simkl-live' },
      }),
      2
    );
  });

  it('rejects an error payload instead of retracting the pack graph', async () => {
    entry.mirrors = [`${base}/pack.json`];
    const first = await refreshPack(entry, { ingest: true });
    assert.equal(first.status, 'downloaded');
    const packLinks = await getRepository(MappingLink).count({
      where: { sourceKey: 'anibridge' },
    });
    assert.ok(packLinks >= 1);

    payload = JSON.stringify({ error: 'rate limited' });
    const second = await refreshPack(entry, {
      ingest: true,
      replacePackGraph: true,
    });
    assert.equal(second.status, 'lastGood');
    assert.equal(
      await getRepository(MappingLink).count({
        where: { sourceKey: 'anibridge' },
      }),
      packLinks
    );
  });

  it('keeps a lower-confidence live mapping when the pack is retracted', async () => {
    entry.mirrors = [`${base}/pack.json`];
    payload = BODY;
    const first = await refreshPack(entry, { ingest: true });
    assert.equal(first.status, 'downloaded');

    await upsertCluster([
      {
        ref: { ns: 'anilist', id: '1' },
        confidence: 80,
        sourceKey: 'simkl-live',
      },
      {
        ref: { ns: 'tmdb_show', id: '111' },
        confidence: 80,
        sourceKey: 'simkl-live',
      },
    ]);

    payload = JSON.stringify({ 'anilist:2': { 'tmdb_show:222': {} } });
    const second = await refreshPack(entry, {
      ingest: true,
      replacePackGraph: true,
    });
    assert.equal(second.status, 'downloaded');

    assert.equal(
      await getRepository(MappingLink).count({
        where: { sourceKey: 'simkl-live' },
      }),
      2
    );
  });
});
