import ImageProxy from '@server/lib/imageproxy';
import avatarproxy, { resetAvatarImageProxy } from '@server/routes/avatarproxy';
import { setupTestDb } from '@server/test/db';
import axios from 'axios';
import express from 'express';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import request from 'supertest';

setupTestDb();

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe('avatarproxy route', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('rejects a malformed avatar ID without leaving the request open', async () => {
    const app = express();
    app.use('/avatarproxy', avatarproxy);

    const response = await request(app).get('/avatarproxy/invalid');

    assert.equal(response.status, 400);
  });

  it('creates the avatar ImageProxy without a media-server Authorization header', async (t) => {
    resetAvatarImageProxy();
    const createdHeaders: unknown[] = [];
    const originalCreate = axios.create.bind(axios);
    t.mock.method(axios, 'create', ((config?: { headers?: unknown }) => {
      createdHeaders.push(config?.headers);
      return originalCreate(config);
    }) as typeof axios.create);
    t.mock.method(ImageProxy.prototype, 'getImage', async () => ({
      meta: {
        revalidateAfter: Date.now() + 1000,
        curRevalidate: 86400,
        isStale: false,
        etag: 'etag',
        extension: 'png',
        cacheKey: 'key',
        cacheMiss: true,
      },
      imageBuffer: png,
    }));

    const app = express();
    app.use('/avatarproxy', avatarproxy);
    const response = await request(app).get(`/avatarproxy/${'a'.repeat(32)}`);

    assert.equal(response.status, 200);
    assert.ok(createdHeaders.length > 0);
    for (const headers of createdHeaders) {
      assert.equal(
        headers && typeof headers === 'object' && 'Authorization' in headers
          ? (headers as { Authorization?: unknown }).Authorization
          : undefined,
        undefined
      );
    }
  });
});
