import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import Media from './Media';

export type ReleaseSource = 'sonarr' | 'radarr';
export type ReleaseDateType = 'air' | 'digital' | 'physical' | 'theatrical';

@Entity()
@Unique('UQ_release_occurrence_source_item_date_type', [
  'source',
  'sourceServerId',
  'sourceItemId',
  'dateType',
])
@Index('IDX_release_occurrence_starts_at_media_type', ['startsAt', 'mediaType'])
@Index('IDX_release_occurrence_missing_since', ['missingSince'])
@Index('IDX_release_occurrence_series_detection', [
  'sourceServerId',
  'sourceSeriesId',
  'seasonNumber',
  'episodeNumber',
])
class ReleaseOccurrence {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar' })
  public source: ReleaseSource;

  @Column()
  public sourceServerId: number;

  @Column()
  public sourceItemId: number;

  @Column({ type: 'integer', nullable: true })
  public sourceSeriesId?: number | null;

  @Column({ type: 'varchar' })
  public mediaType: 'movie' | 'tv';

  @Column({ type: 'integer', nullable: true })
  public tmdbId?: number | null;

  @Column({ type: 'integer', nullable: true })
  public tvdbId?: number | null;

  @Column({ type: 'integer', nullable: true })
  @Index()
  public mediaId?: number | null;

  @ManyToOne(() => Media, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'mediaId' })
  public media?: Media | null;

  @Column({ type: 'varchar' })
  public title: string;

  @Column({ type: 'varchar', nullable: true })
  public subtitle?: string | null;

  @Column({ type: 'integer', nullable: true })
  public seasonNumber?: number | null;

  @Column({ type: 'integer', nullable: true })
  public episodeNumber?: number | null;

  @Column({ type: 'varchar' })
  public dateType: ReleaseDateType;

  @DbAwareColumn({ type: 'datetime' })
  public startsAt: Date;

  @Column({ default: false })
  public allDay: boolean;

  @Column({ default: true })
  public monitored: boolean;

  @Column({ default: false })
  public hasFile: boolean;

  @Column({ default: false })
  public is4k: boolean;

  @Column({ type: 'varchar', nullable: true })
  public sourceUrl?: string | null;

  @Column({ type: 'text', nullable: true })
  public rawDates?: string | null;

  @DbAwareColumn({ type: 'datetime' })
  public firstSeenAt: Date;

  @DbAwareColumn({ type: 'datetime' })
  public lastSeenAt: Date;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public missingSince?: Date | null;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<ReleaseOccurrence>) {
    Object.assign(this, init);
  }
}

export default ReleaseOccurrence;
