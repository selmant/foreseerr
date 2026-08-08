import calendarRoutes from '@server/routes/calendar';
import express from 'express';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';

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

describe('calendar query errors', () => {
  it('keeps invalid query parsing as a client error', async () => {
    const response = await request(app).get('/calendar');

    assert.equal(response.status, 400);
    assert.match(response.body.message, /start and end are required/i);
  });
});
