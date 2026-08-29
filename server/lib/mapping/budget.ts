import { getRepository } from '@server/datasource';
import type {
  MappingBackpressure,
  MappingCostClass,
} from '@server/entity/MappingSource';
import { MappingSourceUsage } from '@server/entity/MappingSourceUsage';
import logger from '@server/logger';
import { BoundedLru } from './lru';

export interface SourceBudget {
  key: string;
  costClass: MappingCostClass;
  /** Token bucket refill rate. */
  rps: number;
  burst: number;
  concurrency: number;
  dailyQuota?: number;
  /**
   * `none` means the source never returns 429 or rate-limit headers even far
   * above its documented limits, so it must be governed by this local bucket.
   * Simkl enforces out of band by suspending the client_id without warning, so
   * "fire away and back off on 429" would only find out once it was too late.
   */
  backpressure: MappingBackpressure;
  batchSize?: number;
  /** Consecutive failures before the breaker opens. */
  failureThreshold?: number;
  /** How long the breaker stays open before a half-open probe. */
  cooldownMsec?: number;
}

export class QuotaExceededError extends Error {
  public constructor(public readonly sourceKey: string) {
    super(`Daily quota exhausted for mapping source "${sourceKey}"`);
  }
}

export class CircuitOpenError extends Error {
  public constructor(public readonly sourceKey: string) {
    super(`Circuit breaker is open for mapping source "${sourceKey}"`);
  }
}

export class BudgetUnavailableError extends Error {
  public constructor(
    public readonly sourceKey: string,
    public readonly costClass: MappingCostClass
  ) {
    super(`Mapping source "${sourceKey}" does not serve ${costClass} requests`);
  }
}

const utcDay = (at = new Date()): string => at.toISOString().slice(0, 10);

interface QueueEntry {
  release: () => void;
  costClass: 'interactive' | 'bulk';
}

/**
 * Local governor for one source: token bucket, concurrency cap, daily quota, and
 * a circuit breaker.
 */
class SourceGovernor {
  private tokens: number;
  private lastRefillAt = Date.now();
  private active = 0;
  private readonly waiting: QueueEntry[] = [];

  private consecutiveFailures = 0;
  private circuitOpenedAt?: number;
  private halfOpen = false;

  private quotaDay = utcDay();
  private quotaUsed = 0;
  private quotaLoaded = false;
  private quotaInflight?: Promise<void>;

  public constructor(public budget: SourceBudget) {
    this.tokens = budget.burst;
  }

  public get state(): 'closed' | 'open' | 'half-open' {
    if (!this.circuitOpenedAt) return 'closed';
    const cooldown = this.budget.cooldownMsec ?? 5 * 60 * 1000;
    if (Date.now() - this.circuitOpenedAt >= cooldown) return 'half-open';
    return 'open';
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefillAt) / 1000;
    if (elapsed <= 0) return;
    this.lastRefillAt = now;
    this.tokens = Math.min(
      this.budget.burst,
      this.tokens + elapsed * this.budget.rps
    );
  }

  private msecUntilToken(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.budget.rps) * 1000);
  }

  /**
   * Interactive work jumps the queue: a visible page must never wait behind a
   * backfill sweep.
   */
  private enqueue(costClass: 'interactive' | 'bulk'): Promise<void> {
    return new Promise<void>((resolve) => {
      const entry: QueueEntry = { release: resolve, costClass };
      if (costClass === 'interactive') {
        const firstBulk = this.waiting.findIndex(
          (queued) => queued.costClass === 'bulk'
        );
        if (firstBulk >= 0) {
          this.waiting.splice(firstBulk, 0, entry);
          return;
        }
      }
      this.waiting.push(entry);
    });
  }

  private pump(): void {
    while (this.active < this.budget.concurrency && this.waiting.length) {
      const next = this.waiting.shift();
      if (!next) break;
      this.active += 1;
      next.release();
    }
  }

  /**
   * Concurrent callers share one in-flight load. `quotaLoaded` is set only
   * after the DB read finishes, so nobody proceeds on a zeroed counter.
   * A UTC day change starts a fresh load.
   */
  private loadQuota(): Promise<void> {
    const day = utcDay();
    if (this.quotaLoaded && this.quotaDay === day) return Promise.resolve();
    if (!this.quotaInflight) {
      this.quotaInflight = this.readPersistedQuota(day).finally(() => {
        this.quotaInflight = undefined;
      });
    }
    return this.quotaInflight.then(() => {
      if (this.quotaLoaded && this.quotaDay === utcDay()) return;
      return this.loadQuota();
    });
  }

  private async readPersistedQuota(day: string): Promise<void> {
    this.quotaDay = day;
    this.quotaUsed = 0;
    this.quotaLoaded = false;
    if (this.budget.dailyQuota) {
      try {
        const row = await getRepository(MappingSourceUsage).findOne({
          where: { sourceKey: this.budget.key, day },
        });
        this.quotaUsed = row?.requests ?? 0;
      } catch (error) {
        logger.debug('Unable to load mapping source quota', {
          label: 'Mapping',
          source: this.budget.key,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.quotaLoaded = true;
  }

  /**
   * Usage writes are chained rather than fired in parallel: two concurrent
   * inserts for the same `(sourceKey, day)` would collide on the unique index
   * and lose a count.
   */
  private usageChain: Promise<void> = Promise.resolve();

  private persistUsage(failed: boolean): Promise<void> {
    this.usageChain = this.usageChain.then(() => this.writeUsage(failed));
    return this.usageChain;
  }

  private async writeUsage(failed: boolean): Promise<void> {
    const repository = getRepository(MappingSourceUsage);
    const day = utcDay();
    try {
      const updated = await repository
        .createQueryBuilder()
        .update(MappingSourceUsage)
        .set({
          requests: () => '"requests" + 1',
          ...(failed ? { failures: () => '"failures" + 1' } : {}),
        })
        .where('sourceKey = :sourceKey', { sourceKey: this.budget.key })
        .andWhere('day = :day', { day })
        .execute();
      if (!updated.affected) {
        await repository.insert({
          sourceKey: this.budget.key,
          day,
          requests: 1,
          failures: failed ? 1 : 0,
          itemsResolved: 0,
        });
      }
    } catch (error) {
      logger.debug('Unable to persist mapping source usage', {
        label: 'Mapping',
        source: this.budget.key,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.circuitOpenedAt = undefined;
    this.halfOpen = false;
  }

  public recordFailure(): void {
    this.consecutiveFailures += 1;
    const threshold = this.budget.failureThreshold ?? 5;
    if (this.consecutiveFailures >= threshold) {
      this.circuitOpenedAt = Date.now();
      logger.warn('Mapping source circuit breaker opened', {
        label: 'Mapping',
        source: this.budget.key,
        consecutiveFailures: this.consecutiveFailures,
      });
    }
  }

  /** Trip the breaker immediately, for a proven credential or quota failure. */
  public trip(reason: string): void {
    this.circuitOpenedAt = Date.now();
    this.consecutiveFailures = this.budget.failureThreshold ?? 5;
    logger.error('Mapping source circuit breaker tripped', {
      label: 'Mapping',
      source: this.budget.key,
      reason,
    });
  }

  public reset(): void {
    this.recordSuccess();
  }

  public flushUsage(): Promise<void> {
    return this.usageChain;
  }

  public snapshot() {
    return {
      key: this.budget.key,
      circuitState: this.state,
      consecutiveFailures: this.consecutiveFailures,
      queued: this.waiting.length,
      active: this.active,
      quotaUsed: this.quotaUsed,
      dailyQuota: this.budget.dailyQuota,
      tokens: Math.floor(this.tokens),
    };
  }

  public async run<T>(
    costClass: 'interactive' | 'bulk',
    task: () => Promise<T>
  ): Promise<T> {
    const { costClass: allowed } = this.budget;
    if (allowed !== 'both' && allowed !== costClass) {
      throw new BudgetUnavailableError(this.budget.key, costClass);
    }

    const state = this.state;
    if (state === 'open') throw new CircuitOpenError(this.budget.key);
    if (state === 'half-open') {
      // Let exactly one probe through while half-open.
      if (this.halfOpen) throw new CircuitOpenError(this.budget.key);
      this.halfOpen = true;
    }

    if (this.active >= this.budget.concurrency) {
      await this.enqueue(costClass);
    } else {
      this.active += 1;
    }

    try {
      for (
        let wait = this.msecUntilToken();
        wait > 0;
        wait = this.msecUntilToken()
      ) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      this.tokens -= 1;

      await this.loadQuota();
      if (
        this.budget.dailyQuota !== undefined &&
        this.quotaUsed >= this.budget.dailyQuota
      ) {
        throw new QuotaExceededError(this.budget.key);
      }
      this.quotaUsed += 1;

      try {
        const result = await task();
        this.recordSuccess();
        void this.persistUsage(false);
        return result;
      } catch (error) {
        this.recordFailure();
        void this.persistUsage(true);
        throw error;
      }
    } finally {
      this.active -= 1;
      this.pump();
    }
  }
}

/**
 * Starting values, deliberately far below the measured ceilings for the sources
 * that give no backpressure at all (Simkl served 76 req/s on /redirect without a
 * single 429 or rate-limit header).
 */
export const DEFAULT_BUDGETS: SourceBudget[] = [
  {
    key: 'simkl-redirect',
    costClass: 'interactive',
    rps: 4,
    burst: 4,
    concurrency: 2,
    backpressure: 'none',
  },
  {
    // Edge-cached (cf-cache-status HIT, age 5.3 h), so safely parallel.
    key: 'simkl-detail',
    costClass: 'interactive',
    rps: 8,
    burst: 8,
    concurrency: 4,
    backpressure: 'none',
  },
  {
    key: 'anizip',
    costClass: 'interactive',
    rps: 2,
    burst: 2,
    concurrency: 2,
    backpressure: 'none',
  },
  {
    key: 'kitsu',
    costClass: 'interactive',
    rps: 2,
    burst: 2,
    concurrency: 2,
    backpressure: 'none',
  },
  {
    key: 'tmdb-find',
    costClass: 'both',
    rps: 10,
    burst: 20,
    concurrency: 8,
    backpressure: 'headers',
  },
  {
    // The only genuine batch resolver, so it owns backfill.
    key: 'mdblist-batch',
    costClass: 'bulk',
    rps: 1,
    burst: 2,
    concurrency: 1,
    dailyQuota: 1000,
    batchSize: 200,
    backpressure: 'none',
  },
  {
    key: 'anilist',
    costClass: 'both',
    rps: 25 / 60,
    burst: 5,
    concurrency: 2,
    backpressure: 'headers',
  },
  {
    key: 'tvdb',
    costClass: 'both',
    rps: 2,
    burst: 4,
    concurrency: 2,
    backpressure: 'headers',
  },
];

const governors = new Map<string, SourceGovernor>();

export function configureBudget(budget: SourceBudget): void {
  const existing = governors.get(budget.key);
  if (existing) existing.budget = budget;
  else governors.set(budget.key, new SourceGovernor(budget));
}

for (const budget of DEFAULT_BUDGETS) configureBudget(budget);

const governorFor = (key: string): SourceGovernor => {
  const existing = governors.get(key);
  if (existing) return existing;
  const fallback = new SourceGovernor({
    key,
    costClass: 'both',
    rps: 2,
    burst: 4,
    concurrency: 2,
    backpressure: 'none',
  });
  governors.set(key, fallback);
  return fallback;
};

export const withBudget = <T>(
  sourceKey: string,
  costClass: 'interactive' | 'bulk',
  task: () => Promise<T>
): Promise<T> => governorFor(sourceKey).run(costClass, task);

export const tripCircuit = (sourceKey: string, reason: string): void =>
  governorFor(sourceKey).trip(reason);

export const resetCircuit = (sourceKey: string): void =>
  governorFor(sourceKey).reset();

export const budgetSnapshot = () =>
  [...governors.values()].map((governor) => governor.snapshot());

/** Await the persisted request counters, for the health page and for tests. */
export const flushBudgetUsage = async (): Promise<void> => {
  await Promise.all([...governors.values()].map((g) => g.flushUsage()));
};

export const budgetFor = (sourceKey: string): SourceBudget =>
  governorFor(sourceKey).budget;

/** Test seam: drop all governor state. */
export const resetBudgets = (): void => {
  governors.clear();
  for (const budget of DEFAULT_BUDGETS) configureBudget(budget);
};

/**
 * Negative cache for confirmed not-founds.
 *
 * Essential for the sources with no backpressure: re-asking Simkl for an id it
 * does not have, on every slider render, is exactly the traffic pattern that
 * gets a client_id suspended. Also the only safe way to handle Simkl's `412`,
 * which means "unknown id", "you sent HEAD", or "credential failure" depending
 * on context.
 */
const NEGATIVE_TTL_MSEC = 6 * 3600 * 1000;
const negative = new BoundedLru<string, true>(50_000, NEGATIVE_TTL_MSEC);

export const negativeKey = (sourceKey: string, request: string): string =>
  `${sourceKey}|${request}`;

export const isNegativelyCached = (
  sourceKey: string,
  request: string
): boolean => negative.has(negativeKey(sourceKey, request));

export const cacheNegative = (sourceKey: string, request: string): void => {
  negative.set(negativeKey(sourceKey, request), true);
};

export const clearNegativeCache = (): void => negative.clear();

export interface DailyUsage {
  sourceKey: string;
  day: string;
  requests: number;
  failures: number;
  itemsResolved: number;
}

export async function dailyUsage(days = 7): Promise<DailyUsage[]> {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  return getRepository(MappingSourceUsage)
    .createQueryBuilder('usage')
    .where('usage.day >= :since', { since: utcDay(since) })
    .orderBy('usage.day', 'DESC')
    .addOrderBy('usage.sourceKey', 'ASC')
    .getMany();
}

export { utcDay };
