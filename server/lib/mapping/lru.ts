/**
 * Bounded LRU with optional TTL.
 *
 * The mapping graph is queried from the database rather than held in RAM: the
 * old flat file loaded 7.5 MB into several Maps on a 4 GB host, and the graph is
 * an order of magnitude larger. This sits in front of those queries with a hard
 * entry cap so memory stays bounded regardless of catalogue size.
 */
export class BoundedLru<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt?: number }>();

  public constructor(
    private readonly maxEntries: number,
    private readonly ttlMsec?: number
  ) {}

  public get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert to move the key to the most-recent end of the Map.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  public has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  public set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, {
      value,
      ...(this.ttlMsec ? { expiresAt: Date.now() + this.ttlMsec } : {}),
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  public delete(key: K): void {
    this.entries.delete(key);
  }

  public clear(): void {
    this.entries.clear();
  }

  public get size(): number {
    return this.entries.size;
  }
}
