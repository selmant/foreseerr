import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Refresh state of one bulk mapping dataset.
 *
 * `generation` is the pointer readers follow: a refresh writes its edges under
 * the next generation and only then moves this, so a lookup never sees a
 * half-written dataset.
 */
@Entity()
export class MappingDataset {
  @PrimaryColumn({ type: 'varchar' })
  public key: string;

  @Column({ type: 'boolean', default: true })
  public enabled: boolean;

  @Column({ type: 'integer', default: 0 })
  public generation: number;

  @Column({ type: 'integer', nullable: true })
  public edgeCount?: number | null;

  /** Upstream's own build stamp when it publishes one, else a content hash. */
  @Column({ type: 'varchar', nullable: true })
  public version?: string | null;

  @Column({ type: 'varchar', nullable: true })
  public etag?: string | null;

  @Column({ type: 'varchar', nullable: true })
  public lastModified?: string | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastFetchedAt?: Date | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastSuccessAt?: Date | null;

  @Column({ type: 'text', nullable: true })
  public lastError?: string | null;
}
