import calendarRoutes, { parseRange } from '@server/routes/calendar';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import request from 'supertest';

const API_SPEC_PATH = join(__dirname, '../../seerr-api.yml');

const app = express();
app.use('/calendar', calendarRoutes);
app.use(
  (
    error: { status?: number; message?: string },
    _req: express.Request,
    res: express.Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _next: express.NextFunction
  ) => res.status(error.status ?? 500).json({ message: error.message })
);

const openApiApp = express();
openApiApp.use(
  OpenApiValidator.middleware({
    apiSpec: API_SPEC_PATH,
    validateRequests: true,
    validateSecurity: false,
  })
);
openApiApp.use('/api/v1/calendar', (_req, res) => res.status(204).end());
openApiApp.use(
  (
    error: { status?: number; message?: string },
    _req: express.Request,
    res: express.Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _next: express.NextFunction
  ) => res.status(error.status ?? 500).json({ message: error.message })
);

describe('calendar query errors', () => {
  it('keeps invalid query parsing as a client error', async () => {
    const response = await request(app).get('/calendar');

    assert.equal(response.status, 400);
    assert.match(response.body.message, /start and end are required/i);
  });
});

describe('calendar range parsing', () => {
  it('treats date-only query keys as UTC midnight bounds', () => {
    const range = parseRange({
      start: '2026-08-01',
      end: '2026-09-12',
    });

    assert.equal(range.start.toISOString(), '2026-08-01T00:00:00.000Z');
    assert.equal(range.end.toISOString(), '2026-09-12T00:00:00.000Z');
  });
});

describe('calendar OpenAPI query', () => {
  it('accepts YYYY-MM-DD range keys used by the calendar UI', async () => {
    const response = await request(openApiApp).get(
      '/api/v1/calendar?start=2026-08-01&end=2026-09-12&scope=mine'
    );

    assert.equal(response.status, 204);
  });

  it('still accepts RFC 3339 date-time bounds', async () => {
    const parameters = new URLSearchParams({
      start: '2026-08-01T00:00:00.000Z',
      end: '2026-09-12T00:00:00.000Z',
      scope: 'mine',
    });
    const response = await request(openApiApp).get(
      `/api/v1/calendar?${parameters.toString()}`
    );

    assert.equal(response.status, 204);
  });
});
