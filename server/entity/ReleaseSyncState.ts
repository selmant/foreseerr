import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';
import type { ReleaseSource } from './ReleaseOccurrence';

/**
 * Durable coordination and progress for one Servarr calendar source.
 *
 * Keeping this separate from occurrences lets replicas coordinate without
 * treating a successful, empty calendar response as an uninitialized source.
 */
@Entity('release_sync_state')
@Unique('UQ_release_sync_state_source_server', ['source', 'sourceServerId'])
@Index('IDX_release_sync_state_lease_expires_at', ['leaseExpiresAt'])
class ReleaseSyncState {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar' })
  public source: ReleaseSource;

  @Column()
  public sourceServerId: number;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastSuccessfulIncrementalAt?: Date | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastSuccessfulBackfillAt?: Date | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastErrorAt?: Date | null;

  @Column({ type: 'text', nullable: true })
  public lastError?: string | null;

  @Column({ type: 'varchar', nullable: true })
  public leaseOwner?: string | null;

  /** Monotonic fencing token; a renewed lease must retain this exact value. */
  @Column({ type: 'integer', default: 0 })
  public leaseFence: number;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public leaseExpiresAt?: Date | null;

  constructor(init?: Partial<ReleaseSyncState>) {
    Object.assign(this, init);
  }
}

export default ReleaseSyncState;
