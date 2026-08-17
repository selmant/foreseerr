import { toCalendarDateKey } from '@server/lib/releases/calendarDateKey';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('toCalendarDateKey', () => {
  it('uses the local calendar date so all-day UTC midnight rows stay in range', () => {
    const local = new Date(2026, 7, 1, 0, 0, 0, 0);
    const key = toCalendarDateKey(local);

    assert.equal(key, '2026-08-01');
    assert.equal(new Date(key).toISOString(), '2026-08-01T00:00:00.000Z');
  });
});
