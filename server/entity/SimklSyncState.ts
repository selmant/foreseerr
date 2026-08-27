import {
  Column,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './User';

/** Per-user checkpoint for the two-phase Simkl Sync API. Tokens never live here. */
@Entity()
export class SimklSyncState {
  @PrimaryGeneratedColumn()
  public id: number;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn()
  public user: User;

  @Column({ type: 'text', nullable: true })
  public activities?: string;

  @Column({ default: false })
  public initialSyncComplete: boolean;

  @Column({ type: 'datetime', nullable: true })
  public lastCheckedAt?: Date;

  @Column({ type: 'datetime', nullable: true })
  public lastSuccessfulSyncAt?: Date;

  @Column({ type: 'text', nullable: true })
  public lastError?: string;
}
