import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { canRunLaunchCatchUp, hasMissedOccurrence } from './catchup';

describe('launch catch-up', () => {
  const now = new Date('2026-08-22T12:00:00Z');

  it('coalesces any number of missed cron occurrences into one decision', () => {
    assert.equal(
      hasMissedOccurrence('* * * * *', new Date('2026-08-22T11:00:00Z'), now),
      true
    );
  });

  it('honors light and heavy failure backoff windows', () => {
    assert.equal(
      canRunLaunchCatchUp(
        '* * * * *',
        'light',
        {
          lastSucceededAt: new Date('2026-08-22T10:00:00Z'),
          lastFailedAt: new Date('2026-08-22T11:45:00Z'),
        },
        now
      ),
      false
    );
    assert.equal(
      canRunLaunchCatchUp(
        '* * * * *',
        'light',
        {
          lastSucceededAt: new Date('2026-08-22T10:00:00Z'),
          lastFailedAt: new Date('2026-08-22T11:30:00Z'),
        },
        now
      ),
      true
    );
    assert.equal(
      canRunLaunchCatchUp(
        '* * * * *',
        'heavy',
        {
          lastSucceededAt: new Date('2026-08-22T01:00:00Z'),
          lastFailedAt: new Date('2026-08-22T07:00:00Z'),
        },
        now
      ),
      false
    );
    assert.equal(
      canRunLaunchCatchUp(
        '* * * * *',
        'heavy',
        {
          lastSucceededAt: new Date('2026-08-22T01:00:00Z'),
          lastFailedAt: new Date('2026-08-22T06:00:00Z'),
        },
        now
      ),
      true
    );
  });

  it('does not invent overdue work without a successful baseline', () => {
    assert.equal(hasMissedOccurrence('* * * * *', undefined, now), false);
    assert.equal(
      hasMissedOccurrence('* * * * *', new Date('2026-08-22T12:00:00Z'), now),
      false
    );
    assert.equal(
      hasMissedOccurrence('not a cron', new Date('2026-08-22T11:00:00Z'), now),
      false
    );
  });
});
