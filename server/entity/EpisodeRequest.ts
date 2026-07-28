import { MediaRequestStatus } from '@server/constants/media';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { MediaRequest } from './MediaRequest';

@Entity()
@Unique('UQ_episode_request_request_tvdb', ['request', 'tvdbId'])
class EpisodeRequest {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  @Index()
  public tvdbId: number;

  @Column()
  public seasonNumber: number;

  @Column()
  public episodeNumber: number;

  @Column({ nullable: true })
  public title?: string;

  @Column({ nullable: true })
  public airDate?: string;

  @Column({ type: 'int', default: MediaRequestStatus.PENDING })
  public status: MediaRequestStatus;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public searchTriggeredAt?: Date;

  @ManyToOne(() => MediaRequest, (request) => request.episodes, {
    onDelete: 'CASCADE',
    orphanedRowAction: 'delete',
  })
  @Index()
  public request: MediaRequest;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<EpisodeRequest>) {
    Object.assign(this, init);
  }
}

export default EpisodeRequest;
