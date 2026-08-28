import type { Namespace } from '@server/lib/mapping/types';
import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * An admin correction. Highest trust in the chain and immutable by sync: no
 * pack refresh or live resolver may modify or delete one.
 */
@Entity()
@Index(['fromNamespace', 'fromExternalId', 'fromSeason', 'toNamespace'], {
  unique: true,
})
export class MappingOverride {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar' })
  public fromNamespace: Namespace;

  @Column({ type: 'varchar' })
  public fromExternalId: string;

  @Column({ type: 'integer', default: -1 })
  public fromSeason: number;

  @Column({ type: 'varchar' })
  public toNamespace: Namespace;

  /** Empty string records "this genuinely does not exist upstream". */
  @Column({ type: 'varchar' })
  public toExternalId: string;

  @Column({ type: 'integer', default: -1 })
  public toSeason: number;

  @Column({ type: 'varchar', nullable: true })
  public note?: string;

  @Column({ type: 'integer', nullable: true })
  public createdByUserId?: number;

  @DbAwareColumn({ type: 'datetime' })
  public createdAt: Date;

  @DbAwareColumn({ type: 'datetime' })
  public updatedAt: Date;
}
