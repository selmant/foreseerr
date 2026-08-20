/**
 * Per-user cache bookkeeping shared by provider snapshot caches.
 *
 * Snapshot shape and optimistic-patch reconciliation deliberately remain in
 * provider adapters; this class owns only lifecycle concerns that must behave
 * identically for every provider: invalidation generations, in-flight fetch
 * de-duplication, and scoped/global clearing.
 */
export interface CacheGeneration {
  user: number;
  global: number;
}

export class UserSnapshotCache<TSnapshot> {
  private readonly snapshots = new Map<string, TSnapshot>();
  private readonly inflight = new Map<string, Promise<TSnapshot>>();
  private readonly userGenerations = new Map<string, number>();
  private globalGeneration = 0;

  public key(userId: number): string {
    return String(userId);
  }

  public get(userId: number): TSnapshot | undefined {
    return this.snapshots.get(this.key(userId));
  }

  public set(userId: number, snapshot: TSnapshot): void {
    this.snapshots.set(this.key(userId), snapshot);
  }

  public getInflight(userId: number): Promise<TSnapshot> | undefined {
    return this.inflight.get(this.key(userId));
  }

  public setInflight(userId: number, value: Promise<TSnapshot>): void {
    this.inflight.set(this.key(userId), value);
  }

  public clearInflight(userId: number): void {
    this.inflight.delete(this.key(userId));
  }

  public generation(userId: number): CacheGeneration {
    return {
      user: this.userGenerations.get(this.key(userId)) ?? 0,
      global: this.globalGeneration,
    };
  }

  public isStale(userId: number, generation: CacheGeneration): boolean {
    return (
      generation.global !== this.globalGeneration ||
      generation.user !== (this.userGenerations.get(this.key(userId)) ?? 0)
    );
  }

  public invalidateUser(userId: number): void {
    const key = this.key(userId);
    this.userGenerations.set(key, (this.userGenerations.get(key) ?? 0) + 1);
    this.snapshots.delete(key);
    this.inflight.delete(key);
  }

  public clear(): void {
    this.globalGeneration += 1;
    this.snapshots.clear();
    this.inflight.clear();
  }
}
