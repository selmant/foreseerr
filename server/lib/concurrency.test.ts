import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SCAN_ITEM_CONCURRENCY, mapWithConcurrency } from './concurrency';

describe('mapWithConcurrency', () => {
  it('preserves order and respects concurrency', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = [1, 2, 3, 4, 5, 6];

    const results = await mapWithConcurrency(items, 2, async (item) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return item * 10;
    });

    assert.deepEqual(results, [10, 20, 30, 40, 50, 60]);
    assert.ok(maxInFlight <= 2);
  });

  it('returns empty array for empty input', async () => {
    const results = await mapWithConcurrency([], 5, async (item) => item);
    assert.deepEqual(results, []);
  });
});

describe('SCAN_ITEM_CONCURRENCY', () => {
  it('stays well under the default Postgres pool of 10', () => {
    assert.ok(SCAN_ITEM_CONCURRENCY >= 1);
    assert.ok(SCAN_ITEM_CONCURRENCY < 10);
  });
});
