import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './User';

export type SimklItemType = 'movie' | 'show' | 'anime';
export type SimklItemStatus =
  | 'watching'
  | 'plantowatch'
  | 'hold'
  | 'completed'
  | 'dropped';

/** Local, display-safe mirror of a user's Simkl library item. */
@Entity()
@Index(['user', 'simklType', 'simklId'], { unique: true })
@Index(['user', 'status'])
@Index(['user', 'tmdbId'])
export class SimklSyncItem {
  @PrimaryGeneratedColumn()
  public id: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  public user: User;

  @Column({ type: 'varchar' })
  public simklId: string;

  @Column({ type: 'varchar' })
  public simklType: SimklItemType;

  @Column({ type: 'integer', nullable: true })
  public tmdbId?: number;

  @Column({ type: 'integer', nullable: true })
  public tvdbId?: number;

  @Column({ type: 'varchar', nullable: true })
  public slug?: string;

  @Column({ type: 'varchar' })
  public title: string;

  @Column({ type: 'integer', nullable: true })
  public year?: number;

  @Column({ type: 'varchar', nullable: true })
  public posterPath?: string;

  @Column({ type: 'varchar', nullable: true })
  public animeType?: string;

  @Column({ type: 'varchar' })
  public status: SimklItemStatus;

  @Column({ type: 'float', nullable: true })
  public userRating?: number;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public addedAt?: Date;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastWatchedAt?: Date;

  @Column({ type: 'integer', nullable: true })
  public watchedEpisodeCount?: number;

  @Column({ type: 'integer', nullable: true })
  public totalEpisodeCount?: number;
}
