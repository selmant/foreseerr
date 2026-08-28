import type { ClusterKind } from '@server/lib/mapping/types';
import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { MappingEpisodeRule } from './MappingEpisodeRule';
import type { MappingLink } from './MappingLink';

/** One real-world work, whatever each provider calls it. */
@Entity()
@Index(['canonicalTmdbType', 'canonicalTmdbId'])
export class MappingCluster {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar' })
  public kind: ClusterKind;

  @Column({ type: 'integer', nullable: true })
  public canonicalTmdbId?: number | null;

  @Column({ type: 'varchar', nullable: true })
  public canonicalTmdbType?: 'movie' | 'tv' | null;

  @Column({ type: 'varchar', nullable: true })
  public title?: string;

  @Column({ type: 'integer', nullable: true })
  public year?: number;

  @OneToMany('MappingLink', 'cluster')
  public links: MappingLink[];

  @OneToMany('MappingEpisodeRule', 'cluster')
  public episodeRules: MappingEpisodeRule[];

  @DbAwareColumn({ type: 'datetime' })
  public createdAt: Date;

  @DbAwareColumn({ type: 'datetime' })
  public updatedAt: Date;
}
