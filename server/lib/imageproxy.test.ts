import ImageProxy from '@server/lib/imageproxy';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const DAY_MS = 24 * 60 * 60 * 1000;

const seedEntry = async (
  cacheRoot: string,
  group: string,
  key: string,
  options: { size: number; expireAt: number; accessedAt: number }
): Promise<string> => {
  const directory = join(cacheRoot, 'images', group, key);
  await mkdir(directory, { recursive: true });
  const file = join(directory, `86400.${options.expireAt}.etag.jpg`);
  await writeFile(file, Buffer.alloc(options.size, 1));
  const atime = new Date(options.accessedAt);
  await utimes(file, atime, atime);
  return directory;
};

describe('ImageProxy.maintainCache', () => {
  const previousCacheDirectory = process.env.CACHE_DIRECTORY;
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), 'foreseerr-image-cache-'));
    process.env.CACHE_DIRECTORY = cacheRoot;
  });

  afterEach(async () => {
    if (previousCacheDirectory === undefined) {
      delete process.env.CACHE_DIRECTORY;
    } else {
      process.env.CACHE_DIRECTORY = previousCacheDirectory;
    }
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it('drops unread images past the idle window and keeps recently touched ones', async () => {
    const expireAt = Date.now() + DAY_MS;
    await seedEntry(cacheRoot, 'tmdb', 'idle-key', {
      size: 32,
      expireAt,
      accessedAt: Date.now() - 3 * DAY_MS,
    });
    await seedEntry(cacheRoot, 'anilist', 'fresh-key', {
      size: 32,
      expireAt,
      accessedAt: Date.now() - 60 * 60 * 1000,
    });

    await ImageProxy.maintainCache({
      idleMs: 2 * DAY_MS,
      highWaterBytes: 1024 * 1024,
      trimTargetBytes: 512 * 1024,
    });

    assert.deepEqual(await readdir(join(cacheRoot, 'images', 'tmdb')), []);
    assert.deepEqual(await readdir(join(cacheRoot, 'images', 'anilist')), [
      'fresh-key',
    ]);
  });

  it('still trims by size after idle eviction', async () => {
    const expireAt = Date.now() + DAY_MS;
    const now = Date.now();
    await seedEntry(cacheRoot, 'tmdb', 'idle-key', {
      size: 200,
      expireAt,
      accessedAt: now - 10 * DAY_MS,
    });
    await seedEntry(cacheRoot, 'tmdb', 'old-fresh', {
      size: 80,
      expireAt,
      accessedAt: now - 2 * 60 * 60 * 1000,
    });
    await seedEntry(cacheRoot, 'tvdb', 'new-fresh', {
      size: 80,
      expireAt,
      accessedAt: now - 60 * 1000,
    });

    await ImageProxy.maintainCache({
      idleMs: 2 * DAY_MS,
      highWaterBytes: 100,
      trimTargetBytes: 80,
    });

    assert.deepEqual(await readdir(join(cacheRoot, 'images', 'tmdb')), []);
    assert.deepEqual(await readdir(join(cacheRoot, 'images', 'tvdb')), [
      'new-fresh',
    ]);
  });
});
