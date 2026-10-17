import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  PROVIDER_ROW_MAX_AGE_SECONDS,
  cachedProviderRow,
  clearProviderRowCache,
  markProviderRowsStale,
} from './rowCache';

const realNow = Date.now;
let now = 1_000_000;

beforeEach(() => {
  now = 1_000_000;
  Date.now = () => now;
  clearProviderRowCache();
});

afterEach(() => {
  Date.now = realNow;
  clearProviderRowCache();
});

/** Let queued background work run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function counter(values: (number | Error)[]) {
  let calls = 0;
  const run = async () => {
    const value = values[Math.min(calls, values.length - 1)];
    calls += 1;
    if (value instanceof Error) throw value;
    return value;
  };
  return { run, calls: () => calls };
}

describe('cachedProviderRow', () => {
  it('serves a fresh row without computing again', async () => {
    const c = counter([1, 2]);
    assert.equal(await cachedProviderRow('k', 60, c.run), 1);
    now += 59_000;
    assert.equal(await cachedProviderRow('k', 60, c.run), 1);
    assert.equal(c.calls(), 1);
  });

  it('serves a stale row at once and refreshes it in the background', async () => {
    const c = counter([1, 2]);
    await cachedProviderRow('k', 60, c.run);
    now += 61_000;
    assert.equal(await cachedProviderRow('k', 60, c.run), 1, 'stale first');
    await settle();
    assert.equal(c.calls(), 2);
    assert.equal(await cachedProviderRow('k', 60, c.run), 2, 'then fresh');
  });

  it('runs one refresh for many stale reads', async () => {
    let release!: (value: number) => void;
    let calls = 0;
    const run = () => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(1)
        : new Promise<number>((resolve) => (release = resolve));
    };
    await cachedProviderRow('k', 0, run);
    const served = await Promise.all(
      [1, 2, 3].map(() => cachedProviderRow('k', 0, run))
    );
    assert.deepEqual(served, [1, 1, 1]);
    assert.equal(calls, 2);
    release(2);
    await settle();
    assert.equal(await cachedProviderRow('k', 60, run), 2);
  });

  it('shares one computation between concurrent misses, errors included', async () => {
    let calls = 0;
    const run = async () => {
      calls += 1;
      await settle();
      throw new Error('upstream down');
    };
    const results = await Promise.allSettled([
      cachedProviderRow('k', 60, run),
      cachedProviderRow('k', 60, run),
    ]);
    assert.equal(calls, 1);
    assert.deepEqual(
      results.map((r) => r.status),
      ['rejected', 'rejected']
    );
    // A failed miss stores nothing: the next read computes again.
    await assert.rejects(cachedProviderRow('k', 60, run));
    assert.equal(calls, 2);
  });

  it('keeps the stored row when a refresh fails', async () => {
    const c = counter([1, new Error('boom'), 3]);
    await cachedProviderRow('k', 60, c.run);
    now += 61_000;
    assert.equal(await cachedProviderRow('k', 60, c.run), 1);
    await settle();
    assert.equal(await cachedProviderRow('k', 60, c.run), 1, 'still stored');
    await settle();
    assert.equal(c.calls(), 3);
    assert.equal(await cachedProviderRow('k', 60, c.run), 3);
  });

  it('treats a row past the hard maximum age as a miss', async () => {
    const c = counter([1, 2]);
    await cachedProviderRow('k', 60, c.run);
    now += PROVIDER_ROW_MAX_AGE_SECONDS * 1000;
    assert.equal(await cachedProviderRow('k', 60, c.run), 2);
    assert.equal(c.calls(), 2);
  });

  it('keeps keys apart', async () => {
    assert.equal(await cachedProviderRow('a', 60, async () => 'a'), 'a');
    assert.equal(await cachedProviderRow('b', 60, async () => 'b'), 'b');
    assert.equal(await cachedProviderRow('a', 60, async () => 'x'), 'a');
  });

  it('drops rows on a clear, and a computation from before it stores nothing', async () => {
    let release!: (value: number) => void;
    const slow = cachedProviderRow(
      'k',
      60,
      () => new Promise<number>((resolve) => (release = resolve))
    );
    await settle();
    clearProviderRowCache();
    release(1);
    assert.equal(await slow, 1, 'its own caller still gets it');
    assert.equal(await cachedProviderRow('k', 60, async () => 2), 2);
  });

  it('serves marked rows once more while refreshing them', async () => {
    const c = counter([1, 2]);
    await cachedProviderRow('k', 3600, c.run);
    markProviderRowsStale();
    assert.equal(await cachedProviderRow('k', 3600, c.run), 1);
    await settle();
    assert.equal(await cachedProviderRow('k', 3600, c.run), 2);
    assert.equal(c.calls(), 2);
  });
});
