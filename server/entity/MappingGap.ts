import type { Namespace } from '@server/lib/mapping/types';
import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type MappingGapReason =
  /** No candidate id was produced by any resolver. */
  | 'unresolved'
  /** Candidates disagreed, or a single candidate could not be corroborated. */
  | 'ambiguous'
  /** An id was present but does not exist on the target provider. */
  | 'phantom'
  /** The declared media type disagreed with the resolved namespace. */
  | 'wrong-type';

export type MappingGapStatus = 'open' | 'resolved' | 'ignored';

/**
 * An observed unresolved discover item. Filtering an item away is also an event,
 * so every miss is recorded here rather than silently dropped; `hitCount` ranks
 * the repair queue and the bulk backfill so limited quota is spent on titles
 * users actually see.
 */
@Entity()
@Index(['namespace', 'externalId', 'season'], { unique: true })
@Index(['status', 'hitCount'])
@Index(['discoverSource'])
export class MappingGap {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar' })
  public namespace: Namespace;

  @Column({ type: 'varchar' })
  public externalId: string;

  /**
   * `NO_SEASON` (-1) rather than NULL, because Postgres treats NULLs as
   * distinct in a unique index and the upsert must collapse repeat sightings.
   */
  @Column({ type: 'integer', default: -1 })
  public season: number;

  @Column({ type: 'varchar', nullable: true })
  public title?: string;

  @Column({ type: 'integer', nullable: true })
  public year?: number;

  @Column({ type: 'varchar', nullable: true })
  public mediaType?: 'movie' | 'tv';

  @Column({ type: 'varchar', nullable: true })
  public discoverSource?: string;

  @Column({ type: 'varchar', default: 'unresolved' })
  public reason: MappingGapReason;

  @Column({ type: 'varchar', default: 'open' })
  public status: MappingGapStatus;

  /** The id that was rejected, kept so a phantom or wrong-type can be audited. */
  @Column({ type: 'varchar', nullable: true })
  public rejectedTarget?: string;

  @Column({ type: 'varchar', nullable: true })
  public sourceKey?: string;

  /**
   * A quarantined L4 guess, stored as a ref key (`tmdb_show:1429`). It is shown
   * in the repair queue as a pre-filled suggestion and is never consulted by
   * the resolver chain: only an admin accepting it turns it into a mapping.
   */
  @Column({ type: 'varchar', nullable: true })
  public suggestedTarget?: string;

  @Column({ type: 'integer', nullable: true })
  public suggestedConfidence?: number;

  @Column({ type: 'varchar', nullable: true })
  public suggestedBy?: string;

  @Column({ type: 'integer', default: 1 })
  public hitCount: number;

  @DbAwareColumn({ type: 'datetime' })
  public firstSeenAt: Date;

  @DbAwareColumn({ type: 'datetime' })
  public lastSeenAt: Date;
}
