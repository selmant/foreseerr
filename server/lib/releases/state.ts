import dataSource, { isPgsql } from '@server/datasource';
import type { ReleaseSource } from '@server/entity/ReleaseOccurrence';
import ReleaseSyncState from '@server/entity/ReleaseSyncState';
import { Brackets, type EntityManager } from 'typeorm';

export const RELEASE_SYNC_LEASE_MS = 30 * 60 * 1000;

export type ReleaseSyncMode = 'incremental' | 'backfill';

export interface ReleaseSyncLeaseRequest {
  source: ReleaseSource;
  sourceServerId: number;
  owner: string;
}

/** A lease is fenced by a monotonically increasing database token. */
export interface ReleaseSyncLease extends ReleaseSyncLeaseRequest {
  fence: number;
}

const whereFor = (lease: ReleaseSyncLeaseRequest) => ({
  source: lease.source,
  sourceServerId: lease.sourceServerId,
});

const expiryExpression = (leaseMs: number) => {
  const seconds = Math.max(1, Math.ceil(leaseMs / 1000));
  return isPgsql
    ? `CURRENT_TIMESTAMP + INTERVAL '${seconds} seconds'`
    : `datetime('now', '+${seconds} seconds')`;
};

const fencedWhere = (lease: ReleaseSyncLease) => ({
  ...whereFor(lease),
  leaseOwner: lease.owner,
  leaseFence: lease.fence,
});

/** Ensure the unique source row exists before the compare-and-set lease. */
export const ensureReleaseSyncState = async (
  source: ReleaseSource,
  sourceServerId: number
) => {
  const repository = dataSource.getRepository(ReleaseSyncState);
  await repository.upsert({ source, sourceServerId }, [
    'source',
    'sourceServerId',
  ]);
  return repository.findOneByOrFail({ source, sourceServerId });
};

export const getReleaseSyncState = async (
  source: ReleaseSource,
  sourceServerId: number
) =>
  dataSource
    .getRepository(ReleaseSyncState)
    .findOneByOrFail({ source, sourceServerId });

/**
 * The expiry comparison and lease duration are evaluated by the database,
 * avoiding skew between web replicas. A winning UPDATE advances the fence.
 */
export const acquireReleaseSyncLease = async (
  request: ReleaseSyncLeaseRequest,
  leaseMs = RELEASE_SYNC_LEASE_MS
): Promise<ReleaseSyncLease | undefined> => {
  await ensureReleaseSyncState(request.source, request.sourceServerId);
  const result = await dataSource
    .getRepository(ReleaseSyncState)
    .createQueryBuilder()
    .update()
    .set({
      leaseOwner: request.owner,
      leaseExpiresAt: () => expiryExpression(leaseMs),
      leaseFence: () => '"leaseFence" + 1',
    })
    .where(whereFor(request))
    .andWhere(
      new Brackets((query) => {
        query
          .where('"leaseExpiresAt" IS NULL')
          .orWhere('"leaseExpiresAt" <= CURRENT_TIMESTAMP');
      })
    )
    .execute();
  if (result.affected !== 1) return undefined;

  const state = await getReleaseSyncState(
    request.source,
    request.sourceServerId
  );
  return state.leaseOwner === request.owner && state.leaseExpiresAt
    ? { ...request, fence: state.leaseFence }
    : undefined;
};

/** Returns false if another replica fenced this owner out or it expired. */
export const renewReleaseSyncLease = async (
  lease: ReleaseSyncLease,
  leaseMs = RELEASE_SYNC_LEASE_MS
): Promise<boolean> => {
  const result = await dataSource
    .getRepository(ReleaseSyncState)
    .createQueryBuilder()
    .update()
    .set({ leaseExpiresAt: () => expiryExpression(leaseMs) })
    .where(fencedWhere(lease))
    .andWhere('"leaseExpiresAt" > CURRENT_TIMESTAMP')
    .execute();
  return result.affected === 1;
};

/**
 * Verifies the current owner and fence using database time. When called in
 * reconciliation's transaction, Postgres locks the state row through commit
 * so a newly-expired replica cannot interleave its occurrence writes.
 */
export const assertReleaseSyncLease = async (
  lease: ReleaseSyncLease,
  manager: EntityManager = dataSource.manager
): Promise<void> => {
  const query = manager
    .getRepository(ReleaseSyncState)
    .createQueryBuilder('state')
    .where({
      source: lease.source,
      sourceServerId: lease.sourceServerId,
      leaseOwner: lease.owner,
      leaseFence: lease.fence,
    })
    .andWhere('state."leaseExpiresAt" > CURRENT_TIMESTAMP');
  if (isPgsql && manager.queryRunner?.isTransactionActive) {
    query.setLock('pessimistic_write');
  }
  if (!(await query.getOne())) {
    throw new Error('Release calendar sync lease is no longer owned');
  }
};

export const releaseReleaseSyncLease = async (
  lease: ReleaseSyncLease
): Promise<void> => {
  await dataSource
    .getRepository(ReleaseSyncState)
    .update(fencedWhere(lease), { leaseOwner: null, leaseExpiresAt: null });
};

export const markReleaseSyncSuccess = async (
  lease: ReleaseSyncLease,
  mode: ReleaseSyncMode
): Promise<void> => {
  const result = await dataSource
    .getRepository(ReleaseSyncState)
    .createQueryBuilder()
    .update()
    .set({
      ...(mode === 'backfill'
        ? { lastSuccessfulBackfillAt: () => 'CURRENT_TIMESTAMP' }
        : { lastSuccessfulIncrementalAt: () => 'CURRENT_TIMESTAMP' }),
      lastErrorAt: null,
      lastError: null,
    })
    .where(fencedWhere(lease))
    .andWhere('"leaseExpiresAt" > CURRENT_TIMESTAMP')
    .execute();
  if (result.affected !== 1) {
    throw new Error('Release calendar sync lease was lost before completion');
  }
};

export const markReleaseSyncError = async (
  lease: ReleaseSyncLease,
  error: string
): Promise<void> => {
  await dataSource
    .getRepository(ReleaseSyncState)
    .createQueryBuilder()
    .update()
    .set({
      lastErrorAt: () => 'CURRENT_TIMESTAMP',
      lastError: error.slice(0, 2048),
    })
    .where(fencedWhere(lease))
    .andWhere('"leaseExpiresAt" > CURRENT_TIMESTAMP')
    .execute();
};
