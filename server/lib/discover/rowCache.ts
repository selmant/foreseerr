import { onDatasetsChanged } from '@server/lib/mapping/datasets';
import { BoundedLru } from '@server/lib/mapping/lru';
import logger from '@server/logger';

/**
 * Stale-while-revalidate for computed provider rows (a Trakt chart page, an
 * AniList public page, a Simkl trending page, an MDBList list page).
 *
 * A row within its freshness window is served as is. Past it, the stored row is
 * still served at once and one refresh runs in the background; a failed refresh
 * keeps the stored row. Past the hard maximum age a row is a plain miss. Misses
 * and refreshes are single-flight per key.
 *
 * What is stored is the row before anything request-specific: the unmapped
 * sightings, `hideUnmapped` and the request annotations run on every serve.
 */

/** Older than this, a row is a miss however it got there. */
export const PROVIDER_ROW_MAX_AGE_SECONDS = 24 * 60 * 60;

/** Rows kept: pages of a handful of rows per user. */
const MAX_ROWS = 500;

interface Row {
  value: unknown;
  storedAt: number;
  /** The stale mark current when the computation started. */
  epoch: number;
}

const rows = new BoundedLru<string, Row>(
  MAX_ROWS,
  PROVIDER_ROW_MAX_AGE_SECONDS * 1000
);
const flights = new Map<string, Promise<unknown>>();
/** Bumped by a clear, so a computation started before it stores nothing. */
let generation = 0;
/** Bumped when every stored row should count as stale. */
let staleEpoch = 0;

function compute<T>(key: string, run: () => Promise<T>): Promise<T> {
  const flight = flights.get(key);
  if (flight) return flight as Promise<T>;
  const started = generation;
  const epoch = staleEpoch;
  const promise: Promise<T> = Promise.resolve()
    .then(run)
    .then((value) => {
      if (generation === started) {
        rows.set(key, { value, storedAt: Date.now(), epoch });
      }
      return value;
    })
    .finally(() => {
      if (flights.get(key) === promise) flights.delete(key);
    });
  flights.set(key, promise);
  return promise;
}

/**
 * The row under `key`: fresh for `freshSeconds` after it was computed, then
 * served stale while one background refresh replaces it.
 */
export async function cachedProviderRow<T>(
  key: string,
  freshSeconds: number,
  run: () => Promise<T>
): Promise<T> {
  const row = rows.get(key);
  if (!row) return compute(key, run);
  const fresh =
    row.epoch === staleEpoch && Date.now() - row.storedAt < freshSeconds * 1000;
  if (!fresh && !flights.has(key)) {
    compute(key, run).catch((error: unknown) => {
      logger.warn('Provider row refresh failed; serving the stored row', {
        label: 'Discover',
        key,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return row.value as T;
}

/** Drop every row: a mapping correction changes what a row resolves to. */
export function clearProviderRowCache(): void {
  generation += 1;
  rows.clear();
  flights.clear();
}

/** Serve every row once more, refreshing it: the datasets changed. */
export function markProviderRowsStale(): void {
  staleEpoch += 1;
}

onDatasetsChanged(markProviderRowsStale);
