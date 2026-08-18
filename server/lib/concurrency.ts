/**
 * Map over items with a fixed concurrency limit (order-preserving).
 * Caps external API fan-out without adding a dependency.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!items.length) {
    return [];
  }

  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

/** Bound legacy external-provider enrichment when no batch API is available. */
export const EXTERNAL_ENRICHMENT_CONCURRENCY = 2;

/**
 * Cap library / *arr scanner item processing. TypeORM's default Postgres
 * pool is 10, and Media/MediaRequest subscribers nest extra queries inside
 * `save()`. Unbounded `Promise.all` over a 20–50 item bundle exhausts the
 * pool (idle-in-transaction deadlock → NPM 504). Keep this well under the
 * pool so overlapping jobs (Radarr + Jellyfin at :00) still fit.
 */
export const SCAN_ITEM_CONCURRENCY = 2;
