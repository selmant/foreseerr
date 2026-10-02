import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type MappingResolutionOrigin =
  /** An admin's correction. Wins over everything, including the datasets. */
  | 'manual'
  /** TMDB `/find` by IMDb or TVDB id. */
  | 'tmdb-find'
  /** Exact title match on TMDB. A guess, superseded once a dataset knows. */
  | 'title'
  /** Inherited from a prequel's show. A guess, superseded the same way. */
  | 'prequel'
  /** Nothing answered. Retried after a while. */
  | 'miss';

/**
 * Every answer that is not a dataset edge, and every miss.
 *
 * One row per source id and declared media type. `tmdbId` null on a `manual`
 * row records "this has no TMDB counterpart"; null on a `miss` row is the
 * unmapped list.
 */
@Entity()
@Index(['srcNs', 'srcId', 'mediaType'], { unique: true })
@Index(['origin', 'hitCount'])
export class MappingResolution {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar' })
  public srcNs: string;

  /** String because IMDb ids and Trakt slugs are not numeric. */
  @Column({ type: 'varchar' })
  public srcId: string;

  /** Declared type of the source item; empty when the source did not say. */
  @Column({ type: 'varchar', default: '' })
  public mediaType: string;

  @Column({ type: 'integer', nullable: true })
  public tmdbId?: number | null;

  /** May differ from `mediaType`: an OVA can be filed on TMDB as a film. */
  @Column({ type: 'varchar', nullable: true })
  public tmdbType?: 'movie' | 'tv' | null;

  @Column({ type: 'varchar' })
  public origin: MappingResolutionOrigin;

  @Column({ type: 'varchar', nullable: true })
  public title?: string | null;

  @Column({ type: 'integer', nullable: true })
  public year?: number | null;

  @Column({ type: 'varchar', nullable: true })
  public discoverSource?: string | null;

  /** Why a miss happened or what a guess matched on, for the settings page. */
  @Column({ type: 'varchar', nullable: true })
  public detail?: string | null;

  @Column({ type: 'integer', default: 0 })
  public hitCount: number;

  @Column({ type: 'integer', nullable: true })
  public createdByUserId?: number | null;

  /** When the answer was last computed; misses are retried after a TTL. */
  @DbAwareColumn({ type: 'datetime' })
  public checkedAt: Date;

  @DbAwareColumn({ type: 'datetime' })
  public createdAt: Date;

  @DbAwareColumn({ type: 'datetime' })
  public updatedAt: Date;
}
