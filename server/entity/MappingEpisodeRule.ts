import type { Namespace } from '@server/lib/mapping/types';
import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { MappingCluster } from './MappingCluster';

/**
 * One episode-range translation, expressing anibridge semantics such as
 * `{"1-15": "67-81"}` (absolute numbering) and `{"13-": "14-|2"}` (open-ended
 * with a 1:2 ratio). Not anime-gated: split-season and alternate-order Western
 * shows need the same reconciliation.
 */
@Entity()
@Index(['cluster', 'sourceNamespace', 'targetNamespace'])
@Index(['sourceKey'])
export class MappingEpisodeRule {
  @PrimaryGeneratedColumn()
  public id: number;

  @ManyToOne('MappingCluster', 'episodeRules', {
    onDelete: 'CASCADE',
  })
  @JoinColumn()
  public cluster: MappingCluster;

  @Column({ type: 'integer' })
  public clusterId: number;

  @Column({ type: 'varchar' })
  public sourceNamespace: Namespace;

  @Column({ type: 'varchar', nullable: true })
  public sourceExternalId?: string;

  @Column({ type: 'integer', default: -1 })
  public sourceSeason: number;

  /** `"1-13"`, `"13-"`, or `"5"`. */
  @Column({ type: 'varchar' })
  public sourceRange: string;

  @Column({ type: 'varchar' })
  public targetNamespace: Namespace;

  @Column({ type: 'varchar', nullable: true })
  public targetExternalId?: string;

  @Column({ type: 'integer', default: -1 })
  public targetSeason: number;

  @Column({ type: 'varchar' })
  public targetRange: string;

  /** Source episodes consumed per target episode; 1 for a plain offset. */
  @Column({ type: 'integer', default: 1 })
  public ratio: number;

  @Column({ type: 'integer' })
  public confidence: number;

  @Column({ type: 'varchar' })
  public sourceKey: string;

  @DbAwareColumn({ type: 'datetime' })
  public updatedAt: Date;
}
