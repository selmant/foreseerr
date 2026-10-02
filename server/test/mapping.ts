import { getRepository } from '@server/datasource';
import { MappingDataset } from '@server/entity/MappingDataset';
import { resetTmdbValidityCache } from '@server/lib/discover/validity';
import {
  loadActiveGenerations,
  resetDatasetState,
  writeGeneration,
} from '@server/lib/mapping/datasets';
import { clearEdgeCache } from '@server/lib/mapping/edges';
import type { EdgeRow } from '@server/lib/mapping/parsers';
import { resetMissBuffer } from '@server/lib/mapping/resolutions';
import { invalidateResolutions } from '@server/lib/mapping/resolve';
import { clearTmdbNegativeCache } from '@server/lib/mapping/tmdb';

/**
 * Drop everything the mapping layer holds in memory. Each test starts from an
 * empty database, so nothing cached may outlive it.
 */
export function resetMappingState(): void {
  resetMissBuffer();
  resetDatasetState();
  clearEdgeCache();
  invalidateResolutions();
  clearTmdbNegativeCache();
  resetTmdbValidityCache();
}

/** `anilist:1225 -> tmdb_show:62913:s2`, optionally with `{ '1-3': '1-3' }`. */
export const edge = (
  from: string,
  to: string,
  ranges?: Record<string, string>
): EdgeRow[] => {
  const [srcNs, srcId, srcScope = ''] = from.split(':');
  const [dstNs, dstId, dstScope = ''] = to.split(':');
  const base = { srcNs, srcId, srcScope, dstNs, dstId, dstScope };
  const pairs = Object.entries(ranges ?? {});
  return pairs.length
    ? pairs.map(([srcRange, dstRange]) => ({ ...base, srcRange, dstRange }))
    : [base];
};

/** Make a set of edges the readable generation of one dataset. */
export async function seedEdges(
  edges: EdgeRow[],
  dataset = 'anibridge'
): Promise<void> {
  await loadActiveGenerations({ force: true });
  await writeGeneration(dataset, 1, edges);
  await getRepository(MappingDataset).update(dataset, {
    generation: 1,
    edgeCount: edges.length,
  });
  await loadActiveGenerations({ force: true });
  clearEdgeCache();
}
