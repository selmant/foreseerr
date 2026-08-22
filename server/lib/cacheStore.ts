export interface CacheStats {
  usedBytes: number;
  limitBytes: number;
  entries: number;
  evictions: number;
}

export interface CacheStore {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlSeconds?: number): void;
  delete(key: string): void;
  keys(): string[];
  flush(): void;
  stats(): CacheStats;
  getTtl(key: string): number;
}

type Entry = {
  value: unknown;
  size: number;
  expiresAt: number;
  accessedAt: number;
};

export class CacheBudget {
  private usedBytes = 0;
  private evictions = 0;
  private accessSequence = 0;
  private readonly stores = new Set<WeightedLruCacheStore>();
  constructor(readonly limitBytes = 256 * 1024 * 1024) {}
  register(store: WeightedLruCacheStore): void {
    this.stores.add(store);
  }
  add(bytes: number): void {
    this.usedBytes += bytes;
  }
  remove(bytes: number): void {
    this.usedBytes = Math.max(0, this.usedBytes - bytes);
  }
  evicted(): void {
    this.evictions += 1;
  }
  nextAccess(): number {
    this.accessSequence += 1;
    return this.accessSequence;
  }
  ensureCapacity(): void {
    while (this.usedBytes > this.limitBytes) {
      // Prune expiry across every provider before selecting an LRU victim.
      // An expired item must never cause a live response to be discarded.
      for (const store of this.stores) store.oldest();
      if (this.usedBytes <= this.limitBytes) return;
      const candidate = [...this.stores]
        .flatMap((store) => store.oldest())
        .sort((a, b) => a.accessedAt - b.accessedAt)[0];
      if (!candidate) return;
      candidate.store.evict(candidate.key);
    }
  }
  stats(): CacheStats {
    return {
      usedBytes: this.usedBytes,
      limitBytes: this.limitBytes,
      entries: [...this.stores].reduce((sum, store) => sum + store.count(), 0),
      evictions: this.evictions,
    };
  }
}

export class WeightedLruCacheStore implements CacheStore {
  private entries = new Map<string, Entry>();
  constructor(
    private readonly budget: CacheBudget,
    private readonly defaultTtl = 300,
    private readonly limits: {
      maxEntries?: number;
      maxBytes?: number;
      estimateSize?: (value: unknown) => number;
    } = {}
  ) {
    budget.register(this);
  }
  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.evict(key, false);
      return undefined;
    }
    entry.accessedAt = this.budget.nextAccess();
    return entry.value as T;
  }
  set<T>(key: string, value: T, ttlSeconds = this.defaultTtl): void {
    this.evict(key, false);
    const entry = {
      value,
      size: this.limits.estimateSize?.(value) ?? estimateSize(value),
      expiresAt: Date.now() + ttlSeconds * 1000,
      accessedAt: this.budget.nextAccess(),
    };
    this.entries.set(key, entry);
    this.budget.add(entry.size);
    this.removeExpired();
    this.trimToLocalLimits();
    this.budget.ensureCapacity();
  }
  delete(key: string): void {
    this.evict(key, false);
  }
  keys(): string[] {
    this.removeExpired();
    return [...this.entries.keys()];
  }
  flush(): void {
    for (const key of this.entries.keys()) this.evict(key, false);
  }
  stats(): CacheStats {
    return this.budget.stats();
  }
  getTtl(key: string): number {
    return this.entries.get(key)?.expiresAt ?? 0;
  }
  oldest(): {
    store: WeightedLruCacheStore;
    key: string;
    accessedAt: number;
  }[] {
    this.removeExpired();
    return [...this.entries]
      .map(([key, entry]) => ({
        store: this,
        key,
        accessedAt: entry.accessedAt,
      }))
      .sort((a, b) => a.accessedAt - b.accessedAt);
  }
  count(): number {
    this.removeExpired();
    return this.entries.size;
  }
  evict(key: string, count = true): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.budget.remove(entry.size);
    if (count) this.budget.evicted();
  }
  private removeExpired(): void {
    for (const [key, entry] of this.entries)
      if (entry.expiresAt <= Date.now()) this.evict(key, false);
  }
  private trimToLocalLimits(): void {
    while (
      (this.limits.maxEntries !== undefined &&
        this.entries.size > this.limits.maxEntries) ||
      (this.limits.maxBytes !== undefined && this.size() > this.limits.maxBytes)
    ) {
      const oldest = this.oldest()[0];
      if (!oldest) return;
      this.evict(oldest.key);
    }
  }
  private size(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.size;
    return total;
  }
}

const estimateSize = (value: unknown): number => {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (Buffer.isBuffer(value)) return value.length;
  try {
    return Math.min(Buffer.byteLength(JSON.stringify(value)), 1024 * 1024);
  } catch {
    return 1024;
  }
};
