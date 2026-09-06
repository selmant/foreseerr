import ImageProxy from '@server/lib/imageproxy';
import imageproxy from '@server/routes/imageproxy';
import type { Express } from 'express';
import express from 'express';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import request from 'supertest';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const createApp = (): Express => {
  const app = express();
  app.use('/imageproxy', imageproxy);
  return app;
};

describe('imageproxy route', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('rejects unknown sources and unsafe paths', async () => {
    const app = createApp();
    const unknown = await request(app).get('/imageproxy/nope/t/p/x.jpg');
    assert.equal(unknown.status, 400);

    const injected = await request(app).get(
      '/imageproxy/tmdb/https://evil.example/x.jpg'
    );
    assert.equal(injected.status, 403);

    const randomHost = await request(app).get(
      '/imageproxy/anilist/evil.example/file/x.jpg'
    );
    assert.equal(randomHost.status, 403);
  });

  it('allows AniList hosts and fetches through ImageProxy', async () => {
    const getImage = mock.method(
      ImageProxy.prototype,
      'getImage',
      async () => ({
        meta: {
          revalidateAfter: Date.now() + 1000,
          curRevalidate: 86400,
          isStale: false,
          etag: 'etag',
          extension: 'jpg',
          cacheKey: 'key',
          cacheMiss: true,
        },
        imageBuffer: png,
      })
    );

    const app = createApp();
    const res = await request(app).get(
      '/imageproxy/anilist/s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21.jpg'
    );

    assert.equal(res.status, 200);
    assert.equal(getImage.mock.calls.length, 1);
    assert.equal(
      getImage.mock.calls[0]?.arguments[0],
      'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21.jpg'
    );
  });
});
