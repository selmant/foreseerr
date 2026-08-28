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
  `foreseerr-offline-test-${process.pid}`
);
process.env.CONFIG_DIRECTORY = CONFIG_DIRECTORY;
const PACK_DIRECTORY = path.join(CONFIG_DIRECTORY, 'mapping-packs');

// Imported after CONFIG_DIRECTORY is set: the pack directory is resolved at
// module load, and this suite must not read the developer's real packs.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/consistent-type-imports */
const { ensureMappingPacks, resetMappingPackRefreshState } =
  require('@server/lib/mapping/bootstrap') as typeof import('@server/lib/mapping/bootstrap');
const { upsertCluster } =
  require('@server/lib/mapping/graph') as typeof import('@server/lib/mapping/graph');
const mappingService = (
  require('@server/lib/mapping/service') as typeof import('@server/lib/mapping/service')
).default;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/consistent-type-imports */

setupTestDb();

/**
 * Boot with no reachable pack host, which is what a homelab restart during a
 * GitHub outage looks like. The manifest is served locally so the test never
 * touches the network, and every mirror in it points at a closed local port so
 * each download is refused immediately instead of waiting out a connect
 * timeout.
 */
const OFFLINE_MANIFEST = {
  version: 1,
  packs: [
    {
      key: 'anibridge',
      format: 'json-graph',
      mirrors: ['http://127.0.0.1:1/anibridge.json'],
      enabled: true,
      priority: 10,
      trust: 90,
    },
    {
      key: 'anime-lists',
      format: 'xml-animelist',
      mirrors: ['http://127.0.0.1:1/anime-lists.xml'],
      enabled: false,
      priority: 40,
      trust: 75,
    },
  ],
};

let server: Server;

before(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(OFFLINE_MANIFEST));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  process.env.MAPPING_MANIFEST_URL = `http://127.0.0.1:${port}/manifest.json`;
});

after(async () => {
  delete process.env.MAPPING_MANIFEST_URL;
  delete process.env.CONFIG_DIRECTORY;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fsp.rm(CONFIG_DIRECTORY, { recursive: true, force: true });
});

beforeEach(async () => {
  resetMappingPackRefreshState();
  mappingService.invalidate();
  await fsp.rm(PACK_DIRECTORY, { recursive: true, force: true });
  await getRepository(MappingLink).clear();
  await getRepository(MappingCluster).clear();
  await getRepository(MappingSource).clear();
});

describe('offline boot', () => {
  it('does not throw when no pack host is reachable', async () => {
    const results = await ensureMappingPacks({ force: true, ingest: false });

    assert.equal(results.length, OFFLINE_MANIFEST.packs.length);
    assert.equal(
      results.find((result) => result.key === 'anibridge')?.status,
      'failed'
    );
    // A disabled pack is skipped, not counted as an outage.
    assert.equal(
      results.find((result) => result.key === 'anime-lists')?.status,
      'skipped'
    );
  });

  it('falls back to the last good copy instead of losing the pack', async () => {
    await fsp.mkdir(PACK_DIRECTORY, { recursive: true });
    await fsp.writeFile(
      path.join(PACK_DIRECTORY, 'anibridge.json'),
      JSON.stringify({ 'anilist:110277': { 'tmdb_show:1429': {} } }),
      'utf8'
    );

    const results = await ensureMappingPacks({ force: true, ingest: false });

    const anibridge = results.find((result) => result.key === 'anibridge');
    assert.equal(anibridge?.status, 'lastGood');
    assert.equal(anibridge?.records, 1);
  });

  it('keeps serving previously ingested links while packs are unreachable', async () => {
    await upsertCluster(
      [
        {
          ref: { ns: 'anilist', id: '110277' },
          confidence: 90,
          sourceKey: 'anibridge',
        },
        {
          ref: { ns: 'tmdb_show', id: '1429' },
          confidence: 90,
          sourceKey: 'anibridge',
        },
      ],
      { title: 'Attack on Titan', year: 2013 }
    );

    await ensureMappingPacks({ force: true, ingest: false });

    const resolution = await mappingService.resolve(
      { ns: 'anilist', id: '110277' },
      'tmdb_show',
      { offline: true }
    );
    assert.equal(resolution.target?.id, '1429');
    assert.equal(resolution.layer, 'graph');
  });

  it('records the outage against the source so the health page can show it', async () => {
    await ensureMappingPacks({ force: true, ingest: false });

    const source = await getRepository(MappingSource).findOne({
      where: { key: 'anibridge' },
    });
    assert.ok(source?.lastError);
    assert.ok(source.consecutiveFailures >= 1);
  });
});
