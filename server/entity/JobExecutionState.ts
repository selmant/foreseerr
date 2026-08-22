import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Durable scheduler history used for desktop catch-up and retry decisions. */
@Entity()
export class JobExecutionState {
  @PrimaryColumn({ type: 'varchar', length: 128 })
  public jobId: string;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastStartedAt?: Date | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastSucceededAt?: Date | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastFailedAt?: Date | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  public lastFailureSummary?: string | null;

  @Column({ type: 'integer', default: 0 })
  public consecutiveFailures: number;

  constructor(init?: Partial<JobExecutionState>) {
    Object.assign(this, init);
  }
}
