import cacheManager from '@server/lib/cache';
import {
  getCachedLibraryImage,
  resetLibraryImageCache,
  setCachedLibraryImage,
} from '@server/lib/libraryImageCache';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import internalRoutes from '@server/routes/internal';
import settingsRoutes from '@server/routes/settings';
import { setupTestDb } from '@server/test/db';
import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import session from 'express-session';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import request from 'supertest';

const API_SPEC_PATH = join(__dirname, '../../../seerr-api.yml');

let app: Express;
let cacheRoot: string;
const originalCacheDirectory = process.env.CACHE_DIRECTORY;

function createApp() {
  const instance = express();
  instance.use(express.json());
  instance.use(cookieParser());
  instance.use(
    session({ secret: 'test-secret', resave: false, saveUninitialized: false })
  );
  instance.use('/internal', internalRoutes);
  instance.use(
    OpenApiValidator.middleware({
      apiSpec: API_SPEC_PATH,
      validateRequests: true,
    })
  );
  instance.use(checkUser);
  instance.use('/api/v1/settings', settingsRoutes);
  instance.use(
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
  return instance;
}

setupTestDb();

before(async () => {
  app = createApp();
  cacheRoot = await mkdtemp(join(tmpdir(), 'foreseerr-cache-flush-'));
  process.env.CACHE_DIRECTORY = cacheRoot;
});

after(async () => {
  if (originalCacheDirectory === undefined) delete process.env.CACHE_DIRECTORY;
  else process.env.CACHE_DIRECTORY = originalCacheDirectory;
  await rm(cacheRoot, { recursive: true, force: true });
});

// The API key authenticates as the seeded admin, on `/api` and `/internal`.
const API_KEY = 'cache-flush-test-key';
const post = (path: string) =>
  request(app).post(path).set('X-API-Key', API_KEY);

const cachedImage = join('images', 'tmdb', 'poster.jpg');

/** One entry in each cache the flushes clear. */
async function fillCaches() {
  await mkdir(join(cacheRoot, 'images', 'tmdb'), { recursive: true });
  await writeFile(join(cacheRoot, cachedImage), 'image');
  setCachedLibraryImage(1, 'item', 'primary', {
    buffer: Buffer.from('art'),
    contentType: 'image/jpeg',
  });
  cacheManager.getCache('tmdb').data.set('movie/1', { id: 1 });
}

const imageCached = () => existsSync(join(cacheRoot, cachedImage));
const artworkCached = () =>
  getCachedLibraryImage(1, 'item', 'primary') !== undefined;
const tmdbCached = () =>
  cacheManager.getCache('tmdb').data.get('movie/1') !== undefined;

describe('cache flush routes', () => {
  beforeEach(async () => {
    getSettings().main.apiKey = API_KEY;
    await fillCaches();
  });

  afterEach(() => {
    cacheManager.getCache('tmdb').flush();
    resetLibraryImageCache();
  });

  it('flushes the image caches, not the API caches', async () => {
    const res = await post('/api/v1/settings/cache/images/flush');
    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.equal(imageCached(), false, 'the image directory is cleared');
    assert.equal(artworkCached(), false, 'library artwork is dropped');
    assert.equal(tmdbCached(), true, 'API caches stay');
  });

  it('flushes every API cache and the image caches', async () => {
    const res = await post('/api/v1/settings/cache/all/flush');
    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.equal(imageCached(), false, 'the image directory is cleared');
    assert.equal(artworkCached(), false, 'library artwork is dropped');
    assert.equal(tmdbCached(), false, 'API caches are flushed');
  });

  it('still flushes a named cache and rejects an unknown one', async () => {
    const named = await post('/api/v1/settings/cache/tmdb/flush');
    assert.equal(named.status, 204);
    assert.equal(tmdbCached(), false);
    assert.equal(imageCached(), true, 'images stay');

    const unknown = await post('/api/v1/settings/cache/nope/flush');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.message, 'Cache not found.');
  });

  it('answers the internal image and full flushes for the Rust backend', async () => {
    const images = await post('/internal/cache/images/flush');
    assert.equal(images.status, 204, JSON.stringify(images.body));
    assert.equal(imageCached(), false);
    assert.equal(artworkCached(), false);
    assert.equal(tmdbCached(), true);

    await fillCaches();
    const all = await post('/internal/cache/all/flush');
    assert.equal(all.status, 204, JSON.stringify(all.body));
    assert.equal(imageCached(), false);
    assert.equal(artworkCached(), false);
    assert.equal(tmdbCached(), false);
  });
});
