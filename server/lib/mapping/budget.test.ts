import { getRepository } from '@server/datasource';
import { MappingSourceUsage } from '@server/entity/MappingSourceUsage';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  BudgetUnavailableError,
  CircuitOpenError,
  QuotaExceededError,
  budgetSnapshot,
  cacheNegative,
  clearNegativeCache,
  configureBudget,
  flushBudgetUsage,
  isNegativelyCached,
  resetBudgets,
  tripCircuit,
  utcDay,
  withBudget,
} from './budget';

setupTestDb();

beforeEach(async () => {
  await flushBudgetUsage();
  resetBudgets();
  clearNegativeCache();
  await getRepository(MappingSourceUsage).clear();
});

describe('token bucket', () => {
  it('spends burst immediately then paces at the refill rate', async () => {
    configureBudget({
      key: 'paced',
      costClass: 'both',
      rps: 50,
      burst: 2,
      concurrency: 4,
      backpressure: 'none',
    });

    const startedAt = Date.now();
    await Promise.all(
      Array.from({ length: 4 }, () =>
        withBudget('paced', 'interactive', async () => 1)
      )
    );
    const elapsed = Date.now() - startedAt;
    // Two tokens are free; the remaining two cost ~20ms each at 50 rps.
    assert.ok(elapsed >= 30, `expected pacing, took ${elapsed}ms`);
  });

  it('caps parallelism at the configured concurrency', async () => {
    configureBudget({
      key: 'capped',
      costClass: 'both',
      rps: 1000,
      burst: 1000,
      concurrency: 2,
      backpressure: 'none',
    });

    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withBudget('capped', 'interactive', async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
        })
      )
    );
    assert.equal(peak, 2);
  });
});

describe('cost classes', () => {
  it('refuses bulk work on an interactive-only source', async () => {
    // Simkl must never serve bulk: its docs ask you to make contact before
    // batch resolving, and a backfill loop is the likeliest way to get the
    // instance's client_id suspended.
    await assert.rejects(
      withBudget('simkl-redirect', 'bulk', async () => 1),
      BudgetUnavailableError
    );
    assert.equal(
      await withBudget('simkl-redirect', 'interactive', async () => 1),
      1
    );
  });

  it('refuses interactive work on a bulk-only source', async () => {
    await assert.rejects(
      withBudget('mdblist-batch', 'interactive', async () => 1),
      BudgetUnavailableError
    );
  });

  it('lets an interactive request jump ahead of queued backfill', async () => {
    configureBudget({
      key: 'shared',
      costClass: 'both',
      rps: 1000,
      burst: 1000,
      concurrency: 1,
      backpressure: 'none',
    });

    const order: string[] = [];
    const block = withBudget('shared', 'bulk', async () => {
      order.push('bulk-1');
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    // Let the first task take the only slot.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const queuedBulk = withBudget('shared', 'bulk', async () => {
      order.push('bulk-2');
    });
    const interactive = withBudget('shared', 'interactive', async () => {
      order.push('interactive');
    });

    await Promise.all([block, queuedBulk, interactive]);
    assert.deepEqual(order, ['bulk-1', 'interactive', 'bulk-2']);
  });
});

describe('daily quota', () => {
  it('stops at the quota and persists the counter across a restart', async () => {
    configureBudget({
      key: 'quota-test',
      costClass: 'bulk',
      rps: 1000,
      burst: 1000,
      concurrency: 1,
      dailyQuota: 3,
      backpressure: 'none',
    });

    for (let index = 0; index < 3; index += 1) {
      await withBudget('quota-test', 'bulk', async () => index);
    }
    await assert.rejects(
      withBudget('quota-test', 'bulk', async () => 1),
      QuotaExceededError
    );

    await flushBudgetUsage();
    const [row] = await getRepository(MappingSourceUsage).find();
    assert.equal(row.sourceKey, 'quota-test');
    assert.equal(row.day, utcDay());
    assert.equal(row.requests, 3);

    // A crash-loop must not hand the process a fresh 1,000 requests.
    resetBudgets();
    configureBudget({
      key: 'quota-test',
      costClass: 'bulk',
      rps: 1000,
      burst: 1000,
      concurrency: 1,
      dailyQuota: 3,
      backpressure: 'none',
    });
    await assert.rejects(
      withBudget('quota-test', 'bulk', async () => 1),
      QuotaExceededError
    );
  });

  it('counts failures separately from successes', async () => {
    configureBudget({
      key: 'counted',
      costClass: 'both',
      rps: 1000,
      burst: 1000,
      concurrency: 1,
      backpressure: 'none',
    });
    await withBudget('counted', 'interactive', async () => 1);
    await assert.rejects(
      withBudget('counted', 'interactive', async () => {
        throw new Error('upstream 500');
      })
    );
    await flushBudgetUsage();
    const [row] = await getRepository(MappingSourceUsage).find();
    assert.equal(row.requests, 2);
    assert.equal(row.failures, 1);
  });
});

describe('circuit breaker', () => {
  it('opens after the failure threshold and refuses further calls', async () => {
    configureBudget({
      key: 'flaky',
      costClass: 'both',
      rps: 1000,
      burst: 1000,
      concurrency: 1,
      backpressure: 'none',
      failureThreshold: 2,
      cooldownMsec: 60_000,
    });

    for (let index = 0; index < 2; index += 1) {
      await assert.rejects(
        withBudget('flaky', 'interactive', async () => {
          throw new Error('boom');
        })
      );
    }
    await assert.rejects(
      withBudget('flaky', 'interactive', async () => 1),
      CircuitOpenError
    );
    assert.equal(
      budgetSnapshot().find((entry) => entry.key === 'flaky')?.circuitState,
      'open'
    );
  });

  it('allows exactly one probe once the cooldown elapses, and closes on success', async () => {
    configureBudget({
      key: 'recovering',
      costClass: 'both',
      rps: 1000,
      burst: 1000,
      concurrency: 4,
      backpressure: 'none',
      failureThreshold: 1,
      cooldownMsec: 10,
    });

    await assert.rejects(
      withBudget('recovering', 'interactive', async () => {
        throw new Error('boom');
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const probe = withBudget('recovering', 'interactive', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'ok';
    });
    await assert.rejects(
      withBudget('recovering', 'interactive', async () => 1),
      CircuitOpenError
    );
    assert.equal(await probe, 'ok');
    assert.equal(
      await withBudget('recovering', 'interactive', async () => 2),
      2
    );
  });

  it('trips immediately for a proven credential failure', async () => {
    // A Simkl sentinel probe that also answers 412 means the client_id is
    // suspended, not that the id was unknown.
    tripCircuit('simkl-detail', 'sentinel probe returned 412');
    await assert.rejects(
      withBudget('simkl-detail', 'interactive', async () => 1),
      CircuitOpenError
    );
  });
});

describe('negative cache', () => {
  it('remembers a confirmed not-found per source', () => {
    assert.equal(isNegativelyCached('simkl-detail', 'anime/41262'), false);
    cacheNegative('simkl-detail', 'anime/41262');
    assert.equal(isNegativelyCached('simkl-detail', 'anime/41262'), true);
    assert.equal(isNegativelyCached('kitsu', 'anime/41262'), false);
  });
});
