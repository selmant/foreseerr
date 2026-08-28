import logger from '@server/logger';
import { registerLiveResolvers } from './live';
import {
  loadLocalPacks,
  refreshAllPacks,
  type PackRefreshResult,
} from './packs';
import { syncBundledPacks } from './packs/download';
import { fetchManifest } from './packs/manifest';
import { scrubSimklAnimeMovieCollisions } from './scrub';

const REFRESH_INTERVAL_MSEC = 24 * 3600 * 1000;

let lastRefreshAt = 0;
let inFlight: Promise<PackRefreshResult[]> | undefined;
let scrubbedCollisions = false;
let localBoot: Promise<PackRefreshResult[]> | undefined;

/**
 * Ensure the pack layer is loaded, refreshing at most daily.
 *
 * This awaits the refresh, which downloads tens of megabytes and ingests a
 * quarter of a million records, so it belongs to the scheduled job and the
 * admin action. Read-path callers want `ensureMappingLayer` instead.
 *
 * It must never reject: a dead upstream degrades to the last-good copy on disk
 * (or to no pack layer at all) rather than failing the caller.
 */
export async function ensureMappingPacks(
  options: {
    force?: boolean;
    ingest?: boolean;
  } = {}
): Promise<PackRefreshResult[]> {
  // Cheap and idempotent: the live layer must be present even when the pack
  // refresh is skipped or fails, otherwise an offline boot loses it entirely.
  registerLiveResolvers();

  const stale = Date.now() - lastRefreshAt > REFRESH_INTERVAL_MSEC;
  if (!options.force && !stale) return [];
  if (inFlight) return inFlight;

  inFlight = refreshAllPacks({ ingest: options.ingest ?? true })
    .then((results) => {
      lastRefreshAt = Date.now();
      return results;
    })
    .catch((error) => {
      logger.error('Mapping pack refresh failed', {
        label: 'Mapping',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      // Retry sooner than a full day after a hard failure.
      lastRefreshAt = Date.now() - REFRESH_INTERVAL_MSEC + 3600 * 1000;
      return [];
    })
    .finally(() => {
      inFlight = undefined;
    });

  return inFlight;
}

/**
 * Boot path: copy bundled packs into config, register them from disk (no HTTP),
 * then kick a background network refresh + graph ingest.
 *
 * Discover can answer from the in-memory pack index as soon as this resolves
 * the loadLocalPacks step — typically seconds, not the minutes an ingest takes.
 */
export async function bootstrapMappingAtBoot(): Promise<void> {
  if (process.env.NODE_ENV === 'test') return;
  if (localBoot) {
    await localBoot;
    return;
  }

  registerLiveResolvers();
  localBoot = (async () => {
    const copied = await syncBundledPacks();
    if (copied.length) {
      logger.info('Copied bundled mapping packs into config', {
        label: 'Mapping',
        packs: copied,
      });
    }

    // Register resolvers from disk first so AniList/Simkl work before Postgres
    // ingest finishes. Ingest runs next and is what survives a restart.
    const loaded = await loadLocalPacks({ ingest: false });
    lastRefreshAt = Date.now();

    void loadLocalPacks({ ingest: true })
      .then((ingested) => {
        logger.info('Ingested local mapping packs into the graph', {
          label: 'Mapping',
          results: ingested.map((row) => ({
            key: row.key,
            status: row.status,
            clusters: row.clusters,
          })),
        });
      })
      .catch((error) => {
        logger.error('Local mapping pack ingest failed', {
          label: 'Mapping',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });

    // Network refresh stays in the background; disk already made us useful.
    void ensureMappingPacks({ force: true, ingest: true });

    return loaded;
  })();

  try {
    await localBoot;
  } catch (error) {
    localBoot = undefined;
    logger.error('Mapping boot from disk failed', {
      label: 'Mapping',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Make the mapping layer usable for one lookup, without blocking on I/O.
 *
 * The graph in Postgres is the system of record, so a resolution needs nothing
 * more than the registered resolvers. A stale pack set is refreshed in the
 * background: making a user's first slider of the day wait for a 100 MB
 * download and a full ingest would trade a mapping bug for a worse one.
 */
export function ensureMappingLayer(): void {
  registerLiveResolvers();
  // Unit tests exercise the resolvers against a seeded graph; downloading packs
  // behind their backs would make them slow and network-dependent.
  if (process.env.NODE_ENV === 'test') return;
  if (!scrubbedCollisions) {
    scrubbedCollisions = true;
    void scrubSimklAnimeMovieCollisions().catch((error) => {
      scrubbedCollisions = false;
      logger.error('Unable to scrub Simkl anime movie collisions', {
        label: 'Mapping',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    });
  }
  if (Date.now() - lastRefreshAt <= REFRESH_INTERVAL_MSEC || inFlight) return;
  void ensureMappingPacks();
}

export async function listManifestPacks() {
  return (await fetchManifest()).packs;
}

export const resetMappingPackRefreshState = (): void => {
  lastRefreshAt = 0;
  inFlight = undefined;
  scrubbedCollisions = false;
  localBoot = undefined;
};
