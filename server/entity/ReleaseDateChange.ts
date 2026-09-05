import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type ReleaseOccurrence from './ReleaseOccurrence';

export type ReleaseDateChangeKind =
  | 'announced'
  | 'moved_earlier'
  | 'delayed'
  | 'withdrawn';

@Entity()
class ReleaseDateChange {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'integer' })
  @Index()
  public occurrenceId: number;

  @ManyToOne('ReleaseOccurrence', {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'occurrenceId' })
  public occurrence: ReleaseOccurrence;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public oldStartsAt?: Date | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public newStartsAt?: Date | null;

  @Column({ type: 'varchar' })
  public changeKind: ReleaseDateChangeKind;

  @DbAwareColumn({ type: 'datetime' })
  public detectedAt: Date;

  @Column({ default: false })
  public notifiable: boolean;

  @Column({ type: 'text', nullable: true })
  public metadata?: string | null;

  constructor(init?: Partial<ReleaseDateChange>) {
    Object.assign(this, init);
  }
}

export default ReleaseDateChange;
