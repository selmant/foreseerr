import { getRepository } from '@server/datasource';
import { MappingGap } from '@server/entity/MappingGap';
import { upsertCluster } from '@server/lib/mapping/graph';
import mappingService from '@server/lib/mapping/service';
import {
  refKey,
  seasonValue,
  type IdRef,
  type Namespace,
} from '@server/lib/mapping/types';
import logger from '@server/logger';
import { resolveMdblistBatch } from './mdblist';

export interface BackfillResult {
  examined: number;
  resolved: number;
  batches: number;
}

/**
 * Namespaces MDBList's batch endpoint can take as input, in the order they are
 * worth spending a batch on.
 */
const BATCHABLE: Namespace[] = ['imdb', 'tvdb_show', 'tvdb_movie', 'trakt'];

const mediaTypeFor = (gap: MappingGap): 'movie' | 'show' =>
  gap.mediaType === 'movie' ? 'movie' : 'show';

/**
 * Repair the gaps people actually hit.
 *
 * Ordering by `hitCount` spends the 1,000/day MDBList quota on the ids that
 * appear in sliders instead of on a queue tail nobody renders, which is the whole
 * reason gaps carry a hit counter.
 */
export async function backfillMappingGaps({
  limit = 400,
  offline = false,
}: { limit?: number; offline?: boolean } = {}): Promise<BackfillResult> {
  const repository = getRepository(MappingGap);
  const gaps = await repository
    .createQueryBuilder('gap')
    .where('gap.status = :status', { status: 'open' })
    .andWhere('gap.namespace IN (:...namespaces)', { namespaces: BATCHABLE })
    .orderBy('gap.hitCount', 'DESC')
    .addOrderBy('gap.lastSeenAt', 'DESC')
    .take(Math.min(2000, Math.max(1, limit)))
    .getMany();

  const result: BackfillResult = {
    examined: gaps.length,
    resolved: 0,
    batches: 0,
  };
  if (!gaps.length || offline) return result;

  const grouped = new Map<string, MappingGap[]>();
  for (const gap of gaps) {
    const key = `${gap.namespace}|${mediaTypeFor(gap)}`;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(gap);
    else grouped.set(key, [gap]);
  }

  for (const [key, bucket] of grouped) {
    const [namespace, type] = key.split('|') as [Namespace, 'movie' | 'show'];
    const refs: IdRef[] = bucket.map((gap) => {
      const season = seasonValue(gap.season);
      return {
        ns: namespace,
        id: gap.externalId,
        ...(season === undefined ? {} : { season }),
      };
    });
    const byRef = new Map(
      bucket.map((gap, index) => [refKey(refs[index]), gap])
    );

    let resolutions;
    try {
      resolutions = await resolveMdblistBatch(refs, type);
    } catch (error) {
      logger.warn('MDBList backfill batch failed', {
        label: 'Mapping',
        namespace,
        type,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    result.batches += 1;

    for (const resolution of resolutions) {
      const gap = byRef.get(refKey(resolution.from));
      try {
        await upsertCluster(
          resolution.refs.map((ref) => ({
            ref,
            confidence: 75,
            sourceKey: 'mdblist-batch',
          })),
          { title: resolution.title ?? gap?.title, year: gap?.year }
        );
      } catch (error) {
        logger.debug('Unable to persist backfilled mapping', {
          label: 'Mapping',
          from: refKey(resolution.from),
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      result.resolved += 1;
      if (gap) {
        await repository.update(gap.id, { status: 'resolved' });
      }
    }
  }

  // Newly written links must win over the cached miss that produced the gap.
  if (result.resolved) mappingService.invalidate();

  logger.info('Mapping backfill finished', { label: 'Mapping', ...result });
  return result;
}
