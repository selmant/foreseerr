import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One directed statement from a mapping dataset, stored as published.
 *
 * `anilist:1225 -> tmdb_show:62913:s2 {"1-3": "1-3"}` is one row. Edges are
 * never merged or transitively closed here: the dataset already states every
 * direction it vouches for, and unioning them is what used to pull a whole
 * franchise onto one id.
 */
@Entity()
@Index(['srcNs', 'srcId'])
@Index(['dataset', 'generation'])
export class MappingEdge {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar' })
  public dataset: string;

  @Column({ type: 'integer' })
  public generation: number;

  @Column({ type: 'varchar' })
  public srcNs: string;

  @Column({ type: 'varchar' })
  public srcId: string;

  /** `s2` for a season, `R`/`S`/`O` for an AniDB episode type, else empty. */
  @Column({ type: 'varchar', default: '' })
  public srcScope: string;

  @Column({ type: 'varchar' })
  public dstNs: string;

  @Column({ type: 'varchar' })
  public dstId: string;

  @Column({ type: 'varchar', default: '' })
  public dstScope: string;

  /** Source episode range, e.g. `1-12`. Null when only the ids are stated. */
  @Column({ type: 'varchar', nullable: true })
  public srcRange?: string | null;

  /** Target range as published, including any `|ratio` suffix. */
  @Column({ type: 'varchar', nullable: true })
  public dstRange?: string | null;
}
