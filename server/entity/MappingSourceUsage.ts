import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Persisted daily request counters, one row per source per UTC day.
 *
 * MDBList's 1,000/day resets at midnight UTC; an in-memory counter would reset
 * on every restart, so a crash-loop could burn the whole day's quota before
 * anyone noticed. This table also powers per-source request volume on the
 * health page, which is the only visibility available for sources that give no
 * backpressure at all.
 */
@Entity()
@Index(['sourceKey', 'day'], { unique: true })
export class MappingSourceUsage {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar' })
  public sourceKey: string;

  /** `YYYY-MM-DD` in UTC. */
  @Column({ type: 'varchar' })
  public day: string;

  @Column({ type: 'integer', default: 0 })
  public requests: number;

  @Column({ type: 'integer', default: 0 })
  public failures: number;

  @Column({ type: 'integer', default: 0 })
  public itemsResolved: number;
}
