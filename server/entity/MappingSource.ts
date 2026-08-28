import type { Namespace } from '@server/lib/mapping/types';
import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type MappingSourceKind = 'pack' | 'live';

export type MappingPackFormat =
  | 'json-array'
  | 'json-graph'
  | 'xml-animelist'
  | 'yaml-map'
  | 'ndjson';

export type MappingCostClass = 'interactive' | 'bulk' | 'both';

export type MappingBackpressure = 'headers' | 'none';

export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Per-field trust. Trust is a property of `(source, namespace)`, not of the
 * source: Simkl's `tvdb`/`imdb`/`anidb` ids are reliable while its `tmdb` field
 * is wrong for anime seasons, and Trakt's `tmdb` measured 976/979 correct.
 */
export type NamespaceTrust = Partial<Record<Namespace, number>>;

/**
 * A registered pack or live resolver. Everything that governs how the source is
 * fetched lives here so limits and mirrors can be retuned from the admin UI
 * without a redeploy.
 */
@Entity()
@Index(['kind', 'enabled'])
export class MappingSource {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar', unique: true })
  public key: string;

  @Column({ type: 'varchar' })
  public kind: MappingSourceKind;

  @Column({ type: 'boolean', default: true })
  public enabled: boolean;

  /** Lower runs first within its layer. */
  @Column({ type: 'integer', default: 100 })
  public priority: number;

  @Column({ type: 'integer', default: 50 })
  public trust: number;

  @Column({ type: 'simple-json', nullable: true })
  public namespaceTrust?: NamespaceTrust | null;

  @Column({ type: 'varchar', nullable: true })
  public format?: MappingPackFormat | null;

  /** Ordered: upstream, CDN, then the homelab mirror of last resort. */
  @Column({ type: 'simple-json', nullable: true })
  public mirrors?: string[] | null;

  @Column({ type: 'simple-json', nullable: true })
  public fieldMap?: Record<string, string> | null;

  @Column({ type: 'simple-json', nullable: true })
  public namespaceMap?: Record<string, Namespace> | null;

  @Column({ type: 'varchar', nullable: true })
  public licence?: string | null;

  /** Surfaced in the UI for unlicensed packs such as `anime-lists`. */
  @Column({ type: 'text', nullable: true })
  public legalNote?: string | null;

  @Column({ type: 'varchar', nullable: true })
  public version?: string | null;

  @Column({ type: 'varchar', nullable: true })
  public etag?: string | null;

  @Column({ type: 'varchar', nullable: true })
  public lastModified?: string | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastFetchedAt?: Date | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastSuccessAt?: Date | null;

  @Column({ type: 'text', nullable: true })
  public lastError?: string | null;

  @Column({ type: 'integer', nullable: true })
  public entryCount?: number | null;

  @Column({ type: 'varchar', default: 'both' })
  public costClass: MappingCostClass;

  @Column({ type: 'float', default: 2 })
  public rps: number;

  @Column({ type: 'integer', default: 4 })
  public burst: number;

  @Column({ type: 'integer', default: 2 })
  public concurrency: number;

  @Column({ type: 'integer', nullable: true })
  public dailyQuota?: number | null;

  @Column({ type: 'integer', nullable: true })
  public batchSize?: number | null;

  /**
   * `none` means the source never returns 429 or rate-limit headers, so it must
   * be governed by a local token bucket rather than by observed responses.
   * Simkl enforces out of band by suspending the client_id without warning.
   */
  @Column({ type: 'varchar', default: 'none' })
  public backpressure: MappingBackpressure;

  @Column({ type: 'varchar', default: 'closed' })
  public circuitState: CircuitState;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public circuitOpenedAt?: Date | null;

  @Column({ type: 'integer', default: 0 })
  public consecutiveFailures: number;

  @DbAwareColumn({ type: 'datetime' })
  public createdAt: Date;

  @DbAwareColumn({ type: 'datetime' })
  public updatedAt: Date;
}
