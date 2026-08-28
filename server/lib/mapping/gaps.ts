import { getRepository } from '@server/datasource';
import {
  MappingGap,
  type MappingGapReason,
  type MappingGapStatus,
} from '@server/entity/MappingGap';
import logger from '@server/logger';
import { seasonColumn, type Namespace } from './types';

export interface MappingGapObservation {
  namespace: Namespace;
  externalId: string;
  season?: number | null;
  title?: string;
  year?: number;
  mediaType?: 'movie' | 'tv';
  discoverSource?: string;
  reason?: MappingGapReason;
  rejectedTarget?: string;
  sourceKey?: string;
  /** Quarantined L4 guess, shown for review but never trusted. */
  suggestedTarget?: string;
  suggestedConfidence?: number;
  suggestedBy?: string;
}

const gapKey = (observation: MappingGapObservation): string =>
  `${observation.namespace}:${observation.externalId}:${seasonColumn(observation.season)}`;

/**
 * Sliders re-render constantly, so identical sightings within one window are
 * folded in memory before touching the database.
 */
const FLUSH_WINDOW_MSEC = 5000;
const pending = new Map<
  string,
  { observation: MappingGapObservation; hits: number }
>();
let flushTimer: NodeJS.Timeout | undefined;

async function persist(
  observation: MappingGapObservation,
  hits: number
): Promise<void> {
  const repository = getRepository(MappingGap);
  const now = new Date();
  const season = seasonColumn(observation.season);
  const identity = {
    namespace: observation.namespace,
    externalId: observation.externalId,
    season,
  };

  const updated = await repository
    .createQueryBuilder()
    .update(MappingGap)
    .set({
      hitCount: () => `"hitCount" + ${hits}`,
      lastSeenAt: now,
      // A later sighting of the same gap as a bare "unmapped" tile must not
      // erase a more specific reason (phantom, ambiguous, wrong-type) that the
      // resolver already recorded — that is how LOTR Extended lost its
      // `phantom` label after confirmOrRepair had already rejected the dead id.
      ...(observation.reason && observation.reason !== 'unresolved'
        ? { reason: observation.reason }
        : {}),
      ...(observation.title ? { title: observation.title } : {}),
      ...(observation.year ? { year: observation.year } : {}),
      ...(observation.mediaType ? { mediaType: observation.mediaType } : {}),
      ...(observation.discoverSource
        ? { discoverSource: observation.discoverSource }
        : {}),
      ...(observation.rejectedTarget
        ? { rejectedTarget: observation.rejectedTarget }
        : {}),
      ...(observation.sourceKey ? { sourceKey: observation.sourceKey } : {}),
      ...(observation.suggestedTarget
        ? {
            suggestedTarget: observation.suggestedTarget,
            suggestedConfidence: observation.suggestedConfidence,
            suggestedBy: observation.suggestedBy,
          }
        : {}),
    })
    .where('namespace = :namespace', identity)
    .andWhere('externalId = :externalId', identity)
    .andWhere('season = :season', identity)
    .execute();

  if (updated.affected) return;

  await repository.insert({
    ...identity,
    title: observation.title,
    year: observation.year,
    mediaType: observation.mediaType,
    discoverSource: observation.discoverSource,
    reason: observation.reason ?? 'unresolved',
    status: 'open',
    rejectedTarget: observation.rejectedTarget,
    sourceKey: observation.sourceKey,
    suggestedTarget: observation.suggestedTarget,
    suggestedConfidence: observation.suggestedConfidence,
    suggestedBy: observation.suggestedBy,
    hitCount: hits,
    firstSeenAt: now,
    lastSeenAt: now,
  });
}

async function flush(): Promise<void> {
  flushTimer = undefined;
  const batch = [...pending.values()];
  pending.clear();
  for (const { observation, hits } of batch) {
    try {
      await persist(observation, hits);
    } catch (error) {
      logger.debug('Unable to record mapping gap', {
        label: 'Mapping',
        namespace: observation.namespace,
        externalId: observation.externalId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Record an unresolved discover item. Never throws: telemetry must not be able
 * to break a slider.
 */
export function recordMappingGap(observation: MappingGapObservation): void {
  if (!observation.externalId) return;
  const key = gapKey(observation);
  const existing = pending.get(key);
  if (existing) {
    existing.hits += 1;
    existing.observation = { ...existing.observation, ...observation };
  } else {
    pending.set(key, { observation, hits: 1 });
  }
  if (!flushTimer) {
    flushTimer = setTimeout(() => void flush(), FLUSH_WINDOW_MSEC);
    flushTimer.unref?.();
  }
}

export async function flushMappingGaps(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  await flush();
}

export interface MappingGapQuery {
  status?: MappingGapStatus;
  discoverSource?: string;
  take?: number;
  skip?: number;
}

export async function listMappingGaps({
  status = 'open',
  discoverSource,
  take = 50,
  skip = 0,
}: MappingGapQuery = {}): Promise<{ results: MappingGap[]; total: number }> {
  const query = getRepository(MappingGap)
    .createQueryBuilder('gap')
    .where('gap.status = :status', { status })
    .orderBy('gap.hitCount', 'DESC')
    .addOrderBy('gap.lastSeenAt', 'DESC')
    .take(Math.min(200, Math.max(1, take)))
    .skip(Math.max(0, skip));
  if (discoverSource) {
    query.andWhere('gap.discoverSource = :discoverSource', { discoverSource });
  }
  const [results, total] = await query.getManyAndCount();
  return { results, total };
}

export interface MappingGapSummary {
  openGaps: number;
  totalHits: number;
  byReason: Record<string, number>;
  bySource: Record<string, number>;
  byNamespace: Record<string, number>;
}

const countBy = async (
  column: 'reason' | 'discoverSource' | 'namespace'
): Promise<Record<string, number>> => {
  const rows = await getRepository(MappingGap)
    .createQueryBuilder('gap')
    .select(`gap.${column}`, 'key')
    .addSelect('COUNT(1)', 'count')
    .where('gap.status = :status', { status: 'open' })
    .groupBy(`gap.${column}`)
    .getRawMany<{ key: string | null; count: string | number }>();
  return Object.fromEntries(
    rows.map((row) => [row.key ?? 'unknown', Number(row.count)])
  );
};

export async function summarizeMappingGaps(): Promise<MappingGapSummary> {
  const repository = getRepository(MappingGap);
  const totals = await repository
    .createQueryBuilder('gap')
    .select('COUNT(1)', 'openGaps')
    .addSelect('COALESCE(SUM(gap.hitCount), 0)', 'totalHits')
    .where('gap.status = :status', { status: 'open' })
    .getRawOne<{ openGaps: string | number; totalHits: string | number }>();
  const [byReason, bySource, byNamespace] = await Promise.all([
    countBy('reason'),
    countBy('discoverSource'),
    countBy('namespace'),
  ]);
  return {
    openGaps: Number(totals?.openGaps ?? 0),
    totalHits: Number(totals?.totalHits ?? 0),
    byReason,
    bySource,
    byNamespace,
  };
}
