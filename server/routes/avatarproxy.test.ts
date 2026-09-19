import avatarproxy from '@server/routes/avatarproxy';
import express from 'express';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';

describe('avatarproxy route', () => {
  it('rejects a malformed avatar ID without leaving the request open', async () => {
    const app = express();
    app.use('/avatarproxy', avatarproxy);

    const response = await request(app).get('/avatarproxy/invalid');

    assert.equal(response.status, 400);
  });
});
