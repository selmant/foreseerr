import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { CacheBudget, WeightedLruCacheStore } from './cacheStore';

describe('WeightedLruCacheStore', () => {
  it('enforces one shared byte budget across provider stores', () => {
    const budget = new CacheBudget(5);
    const first = new WeightedLruCacheStore(budget);
    const second = new WeightedLruCacheStore(budget);

    first.set('first', 'four');
    second.set('second', 'four');

    assert.equal(first.get('first'), undefined);
    assert.equal(second.get('second'), 'four');
    assert.equal(budget.stats().usedBytes, 4);
    assert.equal(budget.stats().evictions, 1);
  });

  it('removes expired values before evicting live values', () => {
    const budget = new CacheBudget(5);
    const first = new WeightedLruCacheStore(budget);
    const second = new WeightedLruCacheStore(budget);

    first.set('expired', 'four', -1);
    second.set('live', 'four');

    assert.equal(first.get('expired'), undefined);
    assert.equal(second.get('live'), 'four');
    assert.equal(budget.stats().evictions, 0);
  });

  it('counts buffers without serializing them', () => {
    const budget = new CacheBudget(8);
    const store = new WeightedLruCacheStore(budget);
    const payload = Buffer.from('bytes');

    store.set('buffer', payload);

    assert.equal(store.get<Buffer>('buffer'), payload);
    assert.equal(budget.stats().usedBytes, payload.length);
  });
});
