import logger from '@server/logger';
import {
  loadMappingSourceEnabledState,
  resetMappingSourceEnabledState,
  resetPackGraphRewriteState,
} from './graph';
import { registerLiveResolvers } from './live';
import { refreshAllPacks, type PackRefreshResult } from './packs';
import { fetchManifest } from './packs/manifest';
import { clearPackProgress } from './packs/progress';
import { scrubSimklAnimeMovieCollisions } from './scrub';
import mappingService from './service';

const REFRESH_INTERVAL_MSEC = 24 * 3600 * 1000;

let lastRefreshAt = 0;
let inFlight: Promise<PackRefreshResult[]> | undefined;
let scrubbedCollisions = false;

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
      const anySucceeded = results.some(
        (result) =>
          result.status === 'downloaded' ||
          result.status === 'notModified' ||
          result.status === 'lastGood'
      );
      if (anySucceeded) {
        lastRefreshAt = Date.now();
      } else if (results.some((result) => result.status === 'failed')) {
        lastRefreshAt = Date.now() - REFRESH_INTERVAL_MSEC + 3600 * 1000;
      } else {
        lastRefreshAt = Date.now();
      }
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
 * Make the mapping layer usable for one lookup, without blocking on I/O.
 *
 * The graph is the system of record, so a resolution needs nothing more than
 * the registered resolvers. Packs are never refreshed from here: an ingest
 * stalls every other request for minutes, so it belongs to the nightly job and
 * the admin's Refresh, not to whichever page load finds the packs stale.
 */
export async function ensureMappingLayer(): Promise<void> {
  registerLiveResolvers();
  const disabled = await loadMappingSourceEnabledState();
  for (const key of disabled) mappingService.unregister(key);
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
}

export async function listManifestPacks() {
  return (await fetchManifest()).packs;
}

export const resetMappingPackRefreshState = (): void => {
  lastRefreshAt = 0;
  inFlight = undefined;
  scrubbedCollisions = false;
  clearPackProgress();
  resetPackGraphRewriteState();
  resetMappingSourceEnabledState();
};
