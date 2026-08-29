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
import { MappingCluster } from './MappingCluster';

/**
 * An edge from an external id to a cluster.
 *
 * Links are season-scoped (`season`, with `NO_SEASON` for whole-work links)
 * because 4,066 anime entries in the old flat file collapsed onto 1,239 shared
 * TMDB TV ids; without a season qualifier every one but the first resolved to
 * the wrong show.
 */
@Entity()
@Index(['namespace', 'externalId', 'season', 'cluster'], { unique: true })
@Index(['namespace', 'externalId'])
@Index(['sourceKey'])
export class MappingLink {
  @PrimaryGeneratedColumn()
  public id: number;

  @ManyToOne(() => MappingCluster, (cluster) => cluster.links, {
    onDelete: 'CASCADE',
  })
  @JoinColumn()
  public cluster: MappingCluster;

  @Column({ type: 'integer' })
  public clusterId: number;

  @Column({ type: 'varchar' })
  public namespace: Namespace;

  /** String because Simkl returns ids as strings and IMDB ids are not numeric. */
  @Column({ type: 'varchar' })
  public externalId: string;

  @Column({ type: 'integer', default: -1 })
  public season: number;

  @Column({ type: 'integer' })
  public confidence: number;

  @Column({ type: 'varchar' })
  public sourceKey: string;

  @DbAwareColumn({ type: 'datetime' })
  public createdAt: Date;

  @DbAwareColumn({ type: 'datetime' })
  public updatedAt: Date;
}
