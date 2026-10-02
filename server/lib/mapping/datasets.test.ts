import { getRepository } from '@server/datasource';
import { MappingDataset } from '@server/entity/MappingDataset';
import { MappingEdge } from '@server/entity/MappingEdge';
import { setupTestDb } from '@server/test/db';
import { edge, seedEdges } from '@server/test/mapping';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  listDatasets,
  loadActiveGenerations,
  refreshDataset,
  resetDatasetState,
  setDatasetEnabled,
  writeGeneration,
} from './datasets';
import { clearEdgeCache, datasetTmdb, edgesFrom } from './edges';

setupTestDb();

describe('mapping datasets', () => {
  it('seeds a row per known dataset, enabled and unwritten', async () => {
    const datasets = await listDatasets();
    assert.deepEqual(
      datasets.map(({ key, enabled, generation }) => [
        key,
        enabled,
        generation,
      ]),
      [
        ['anibridge', true, 0],
        ['fribb', true, 0],
      ]
    );
  });

  it('keeps a half-written generation invisible until the pointer moves', async () => {
    await seedEdges(edge('anilist:1', 'tmdb_show:10:s1'));
    // The next refresh has written its rows but not yet switched over.
    await writeGeneration('anibridge', 2, edge('anilist:1', 'tmdb_show:99:s1'));
    assert.deepEqual(
      (await edgesFrom('anilist', '1')).map((row) => row.dstId),
      ['10']
    );

    await getRepository(MappingDataset).update('anibridge', { generation: 2 });
    await loadActiveGenerations({ force: true });
    // The lookup cache is dropped by a real refresh; do the same here.
    clearEdgeCache();
    assert.deepEqual(
      (await edgesFrom('anilist', '1')).map((row) => row.dstId),
      ['99']
    );
  });

  it('writes a large dataset in slices without losing rows', async () => {
    const edges = Array.from({ length: 2300 }, (_, index) =>
      edge(`anilist:${index + 1}`, `tmdb_show:${index + 1}:s1`, {
        '1-12': '1-12',
      })
    ).flat();
    await writeGeneration('anibridge', 1, edges, { sliceMsec: 1 });
    assert.equal(
      await getRepository(MappingEdge).count({ where: { generation: 1 } }),
      2300
    );
  });

  it('hides and deletes a disabled dataset, leaving the other readable', async () => {
    await seedEdges(edge('anilist:1', 'tmdb_show:10:s1'));
    await seedEdges(edge('anilist:2', 'tmdb_show:20:s1'), 'fribb');

    await setDatasetEnabled('fribb', false);
    assert.equal(
      await datasetTmdb({ ns: 'anilist', id: '2' }, 'tv'),
      undefined
    );
    assert.equal(
      (await datasetTmdb({ ns: 'anilist', id: '1' }, 'tv'))?.tmdbId,
      10
    );
    assert.equal(
      await getRepository(MappingEdge).count({ where: { dataset: 'fribb' } }),
      0
    );
  });
});

describe('dataset lookups into TMDB', () => {
  it('answers with the declared type, not whichever edge comes first', async () => {
    await seedEdges([
      // A film that TMDB also files under its show's specials.
      ...edge('anilist:5', 'tmdb_show:30991:s0'),
      ...edge('anilist:5', 'tmdb_movie:11299'),
    ]);
    assert.deepEqual(await datasetTmdb({ ns: 'anilist', id: '5' }, 'movie'), {
      tmdbId: 11299,
      mediaType: 'movie',
    });
    assert.deepEqual(await datasetTmdb({ ns: 'anilist', id: '5' }, 'tv'), {
      tmdbId: 30991,
      mediaType: 'tv',
      season: 0,
    });
  });

  it('prefers the film for an entry that is only a special of its show', async () => {
    await seedEdges([
      ...edge('anilist:5', 'tmdb_show:30991:s0'),
      ...edge('anilist:5', 'tmdb_movie:11299'),
    ]);
    assert.deepEqual(
      await datasetTmdb({ ns: 'anilist', id: '5' }, 'tv', { crossType: true }),
      { tmdbId: 11299, mediaType: 'movie' }
    );
  });

  it('does not answer when the edges name two different works', async () => {
    await seedEdges([
      ...edge('anilist:32', 'tmdb_movie:18491'),
      ...edge('anilist:32', 'tmdb_movie:54270'),
    ]);
    assert.equal(
      await datasetTmdb({ ns: 'anilist', id: '32' }, 'movie'),
      undefined
    );
  });

  it('crosses to the other type only when asked, and only on a stated edge', async () => {
    await seedEdges(edge('anilist:7', 'tmdb_movie:700'));
    const ref = { ns: 'anilist' as const, id: '7' };
    assert.equal(await datasetTmdb(ref, 'tv'), undefined);
    assert.deepEqual(await datasetTmdb(ref, 'tv', { crossType: true }), {
      tmdbId: 700,
      mediaType: 'movie',
    });
  });

  it('pivots through the same entry, never through a franchise', async () => {
    await seedEdges([
      ...edge('anilist:200', 'anidb:20:R'),
      ...edge('anilist:200', 'anidb:20:S'),
      ...edge('anidb:20:R', 'tmdb_show:2000:s1'),
      // The specials scope reaches a film; that is a different work.
      ...edge('anidb:20:S', 'tmdb_movie:999'),
      ...edge('anidb:20:S', 'tmdb_show:4444:s0'),
    ]);
    assert.equal(
      (await datasetTmdb({ ns: 'anilist', id: '200' }, 'tv'))?.tmdbId,
      2000
    );
  });

  it('fills from the secondary dataset only where the primary has no answer', async () => {
    await seedEdges([
      ...edge('anilist:1', 'tmdb_show:10:s1'),
      // Known to the primary, but with no TMDB edge yet.
      ...edge('anilist:2', 'mal:2'),
    ]);
    await seedEdges(
      [
        ...edge('anilist:1', 'tmdb_show:11111:s1'),
        ...edge('anilist:2', 'tmdb_show:20:s1'),
      ],
      'fribb'
    );
    assert.equal(
      (await datasetTmdb({ ns: 'anilist', id: '1' }, 'tv'))?.tmdbId,
      10
    );
    assert.equal(
      (await datasetTmdb({ ns: 'anilist', id: '2' }, 'tv'))?.tmdbId,
      20
    );
  });

  it('narrows a season-scoped question to that season', async () => {
    await seedEdges([
      ...edge('tvdb_show:70973:s1', 'tmdb_show:62913:s1'),
      ...edge('tvdb_show:70973:s2', 'tmdb_show:777:s1'),
    ]);
    assert.equal(
      (await datasetTmdb({ ns: 'tvdb_show', id: '70973', season: 2 }, 'tv'))
        ?.tmdbId,
      777
    );
    // Without a season the show maps to two works, which is not an answer.
    assert.equal(
      await datasetTmdb({ ns: 'tvdb_show', id: '70973' }, 'tv'),
      undefined
    );
  });
});

describe('dataset refresh', () => {
  const body = JSON.stringify({
    $meta: { generated_on: '2026-10-01T00:00:00Z' },
    'anilist:1': { 'tmdb_show:10:s1': { '1-12': '1-12' } },
    'anilist:2': { 'tmdb_show:20:s1': { '1-12': '1-12' } },
  });
  let server: Server;
  let url = '';
  let delayMsec = 0;
  let served = 0;

  before(async () => {
    server = createServer((_req, res) => {
      served += 1;
      setTimeout(() => {
        res.writeHead(200, {
          'content-type': 'application/json',
          etag: '"v1"',
        });
        res.end(body);
      }, delayMsec);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    url =
      typeof address === 'object' && address
        ? `http://127.0.0.1:${address.port}/mappings.json`
        : '';
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    delayMsec = 0;
    served = 0;
  });

  it('downloads, writes and switches to the new copy', async () => {
    const result = await refreshDataset('anibridge', { urls: [url] });
    assert.deepEqual(result, {
      key: 'anibridge',
      status: 'downloaded',
      edges: 2,
    });
    const [row] = (await listDatasets()).filter(
      (dataset) => dataset.key === 'anibridge'
    );
    assert.deepEqual(
      [row.generation, row.edgeCount, row.version, row.etag],
      [1, 2, '2026-10-01T00:00:00Z', '"v1"']
    );
    assert.equal(
      (await datasetTmdb({ ns: 'anilist', id: '2' }, 'tv'))?.tmdbId,
      20
    );
  });

  it('throws away a refresh that was overtaken by a disable', async () => {
    delayMsec = 150;
    const running = refreshDataset('anibridge', { urls: [url] });
    await setDatasetEnabled('anibridge', false);
    assert.equal((await running).status, 'skipped');
    assert.equal(
      await getRepository(MappingEdge).count({
        where: { dataset: 'anibridge' },
      }),
      0
    );
    const [row] = (await listDatasets()).filter(
      (dataset) => dataset.key === 'anibridge'
    );
    assert.deepEqual([row.enabled, row.generation, row.etag], [false, 0, null]);
  });

  it('runs a fresh refresh behind one that a re-enable overtook', async () => {
    delayMsec = 150;
    const first = refreshDataset('anibridge', { urls: [url] });
    await setDatasetEnabled('anibridge', false);
    await setDatasetEnabled('anibridge', true);
    const second = refreshDataset('anibridge', { urls: [url] });
    assert.equal((await first).status, 'skipped');
    assert.equal((await second).status, 'downloaded');
    // The overtaken run noticed before it downloaded anything.
    assert.equal(served, 1);
    assert.equal(
      (await datasetTmdb({ ns: 'anilist', id: '1' }, 'tv'))?.tmdbId,
      10
    );
  });
});

describe('lookups before anything else has loaded the datasets', () => {
  it('load the readable generation themselves rather than caching nothing', async () => {
    await seedEdges(
      edge('tmdb_show:1429:s1', 'anilist:16498', { '1-25': '1-25' })
    );
    // A fresh process: nothing has asked for the datasets' state yet.
    resetDatasetState();
    clearEdgeCache();
    assert.equal((await edgesFrom('tmdb_show', '1429')).length, 1);
  });
});

describe('TVDB ids', () => {
  it('never answer for a show with a film parked in its specials', async () => {
    await seedEdges(edge('tvdb_show:72499:s0', 'tmdb_movie:1857'));
    const ref = { ns: 'tvdb_show' as const, id: '72499' };
    assert.equal(await datasetTmdb(ref, 'tv', { crossType: true }), undefined);
    assert.equal(
      await datasetTmdb(ref, undefined, { crossType: true }),
      undefined
    );
  });
});
