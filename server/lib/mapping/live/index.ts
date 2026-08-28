import mappingService from '@server/lib/mapping/service';
import logger from '@server/logger';
import { anizipResolver } from './anizip';
import { kitsuResolver } from './kitsu';
import { simklResolver } from './simkl';
import { tmdbFindResolver } from './tmdbFind';
import { tvdbResolver } from './tvdb';

export { fetchAnizipMappings } from './anizip';
export type { AnizipEpisode, AnizipMappings } from './anizip';
export { backfillMappingGaps } from './backfill';
export { resolveMdblistBatch } from './mdblist';
export { tmdbFind, tmdbIdExists } from './tmdbFind';

let registered = false;

/**
 * Register the live layer once. Ordering inside the layer comes from each
 * resolver's `trust`, not from this list.
 */
export function registerLiveResolvers(): void {
  if (registered) return;
  registered = true;
  for (const resolver of [
    tmdbFindResolver(),
    tvdbResolver(),
    simklResolver(),
    kitsuResolver(),
    anizipResolver(),
  ]) {
    mappingService.register(resolver);
  }
  logger.debug('Live mapping resolvers registered', { label: 'Mapping' });
}

export function unregisterLiveResolvers(): void {
  for (const key of [
    'tmdb-find',
    'tvdb-remoteid',
    'simkl-live',
    'kitsu',
    'anizip',
  ]) {
    mappingService.unregister(key);
  }
  registered = false;
}
