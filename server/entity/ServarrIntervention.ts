import type { MediaType } from '@server/constants/media';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type ServarrInterventionService = 'radarr' | 'sonarr';
export type ServarrInterventionState =
  | 'active'
  | 'rejecting'
  | 'importing'
  | 'resolved';
export type ServarrInterventionResolution =
  | 'recovered'
  | 'disappeared'
  | 'manual_blocklist'
  | 'automatic_blocklist'
  | 'manual_import';

const stringArray = {
  from: (value: string | null): string[] => {
    try {
      return value ? JSON.parse(value) : [];
    } catch {
      return [];
    }
  },
  to: (value: string[]): string => JSON.stringify(value ?? []),
};

@Entity()
@Index(['serviceType', 'serviceId', 'queueId'])
@Index(['state', 'firstSeenAt'])
export class ServarrIntervention {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar' })
  public serviceType: ServarrInterventionService;

  @Column({ type: 'integer' })
  public serviceId: number;

  @Column({ type: 'varchar' })
  public serviceName: string;

  @Column({ type: 'boolean', default: false })
  public is4k: boolean;

  @Column({ type: 'integer' })
  public queueId: number;

  @Column({ type: 'varchar', nullable: true })
  public downloadId?: string | null;

  @Column({ type: 'varchar', nullable: true })
  public outputPath?: string | null;

  @Column({ type: 'integer' })
  public externalServiceId: number;

  @Column({ type: 'integer' })
  public mediaId: number;

  @Column({ type: 'integer' })
  public tmdbId: number;

  @Column({ type: 'varchar' })
  public mediaType: MediaType;

  @Column({ type: 'varchar' })
  public releaseTitle: string;

  @Column({ type: 'text', transformer: stringArray })
  public warningMessages: string[];

  @Column({ type: 'boolean', default: false })
  public manualImportCapable: boolean;

  @Column({ type: 'varchar', default: 'active' })
  public state: ServarrInterventionState;

  @Column({ type: 'varchar', nullable: true })
  public resolution?: ServarrInterventionResolution | null;

  @Column({ type: 'integer', nullable: true })
  public actedByUserId?: number | null;

  @Column({ type: 'text', nullable: true })
  public cleanupError?: string | null;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public firstSeenAt: Date;

  @DbAwareColumn({ type: 'datetime' })
  public cleanupDeadlineAt: Date;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public resolvedAt?: Date | null;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<ServarrIntervention>) {
    Object.assign(this, init);
  }
}
