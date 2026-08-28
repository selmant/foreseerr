import { getRepository } from '@server/datasource';
import { MappingOverride } from '@server/entity/MappingOverride';
import logger from '@server/logger';
import { recordMappingGap } from './gaps';
import { resolveFromGraph, upsertCluster } from './graph';
import { normalizeTitle, titleScore } from './heuristic';
import { tmdbRecord } from './live/tmdbFind';
import { BoundedLru } from './lru';
import {
  isNamespace,
  refKey,
  seasonColumn,
  seasonValue,
  tmdbMediaType,
  workKey,
  type IdRef,
  type MappingCandidate,
  type MappingResolver,
  type Namespace,
  type ResolverContext,
  type ResolverKind,
} from './types';

export interface ResolveOptions {
  /** Recorded on the gap so the health page can attribute a miss to a slider. */
  discoverSource?: string;
  /** Skip layers above this one; used by the backfill job. */
  minKind?: ResolverKind;
  /** Suppress gap recording, e.g. for speculative internal lookups. */
  silent?: boolean;
  /** Skip live resolvers entirely (offline boot, bulk contexts). */
  offline?: boolean;
  title?: string;
  year?: number;
  mediaType?: 'movie' | 'tv';
  /** Only used by the heuristic layer, as an episode-count tiebreaker. */
  episodeCount?: number;
}

export interface MappingResolution {
  /** Best candidate, or undefined when nothing could be corroborated. */
  target?: IdRef;
  confidence: number;
  sourceKey: string;
  candidates: MappingCandidate[];
  /** True when more than one distinct target survived. */
  ambiguous: boolean;
  layer: ResolverKind | 'cache' | 'none';
}

const HOT_CACHE_MAX_ENTRIES = 20_000;
const HOT_CACHE_TTL_MSEC = 15 * 60 * 1000;

const NOT_FOUND: MappingResolution = {
  confidence: 0,
  sourceKey: 'none',
  candidates: [],
  ambiguous: false,
  layer: 'none',
};

/** Layer order. A candidate from an earlier layer wins outright. */
const LAYER_ORDER: ResolverKind[] = [
  'override',
  'graph',
  'pack',
  'live',
  'heuristic',
];

const distinctWorks = (candidates: MappingCandidate[]): number =>
  new Set(candidates.map((candidate) => workKey(candidate.target))).size;

/**
 * Keep the highest-confidence candidate per work. Season variants of the same
 * id collapse into one answer so anibridge's per-cour edges do not look like
 * four sources disagreeing about one show.
 */
const collapseSeasonVariants = (
  candidates: MappingCandidate[]
): MappingCandidate[] => {
  const best = new Map<string, MappingCandidate>();
  for (const candidate of candidates) {
    const key = workKey(candidate.target);
    const current = best.get(key);
    if (!current || candidate.confidence > current.confidence) {
      best.set(key, candidate);
      continue;
    }
    // Prefer a season-less link when confidence ties: discover tiles ask for
    // the work, not a particular cour.
    if (
      candidate.confidence === current.confidence &&
      candidate.target.season === undefined &&
      current.target.season !== undefined
    ) {
      best.set(key, candidate);
    }
  }
  return [...best.values()];
};

/**
 * When a franchise mega-cluster leaves several equal-confidence TMDB ids,
 * pick the one whose live title matches the discover title. Used for cases
 * like Infinity Castle sharing a cluster with Mugen Train at confidence 90.
 */
async function pickByTitle(
  candidates: MappingCandidate[],
  title: string
): Promise<MappingCandidate | undefined> {
  const wanted = normalizeTitle(title);
  if (!wanted) return undefined;

  const scored: { candidate: MappingCandidate; score: number }[] = [];
  for (const candidate of collapseSeasonVariants(candidates)) {
    const mediaType = tmdbMediaType(candidate.target.ns);
    const tmdbId = Number(candidate.target.id);
    if (!mediaType || !(tmdbId > 0)) continue;
    const record = await tmdbRecord(mediaType, tmdbId);
    if (!record.alive) continue;
    scored.push({
      candidate,
      score: Math.max(
        titleScore(wanted, normalizeTitle(record.title ?? '')),
        titleScore(wanted, normalizeTitle(record.originalTitle ?? ''))
      ),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0].score < 70) return undefined;
  if (scored.length > 1 && scored[0].score - scored[1].score < 10) {
    return undefined;
  }
  return scored[0].candidate;
}

export class MappingService {
  private readonly resolvers: MappingResolver[] = [];
  private readonly hot = new BoundedLru<string, MappingResolution>(
    HOT_CACHE_MAX_ENTRIES,
    HOT_CACHE_TTL_MSEC
  );

  public register(resolver: MappingResolver): void {
    const index = this.resolvers.findIndex((r) => r.key === resolver.key);
    if (index >= 0) this.resolvers[index] = resolver;
    else this.resolvers.push(resolver);
  }

  public unregister(key: string): void {
    const index = this.resolvers.findIndex((r) => r.key === key);
    if (index >= 0) this.resolvers.splice(index, 1);
    this.hot.clear();
  }

  public registered(): MappingResolver[] {
    return [...this.resolvers];
  }

  public invalidate(): void {
    this.hot.clear();
  }

  private resolversFor(kind: ResolverKind): MappingResolver[] {
    return this.resolvers
      .filter((resolver) => resolver.kind === kind)
      .sort((a, b) => b.trust - a.trust);
  }

  private async resolveOverride(
    from: IdRef,
    to: Namespace
  ): Promise<MappingCandidate[]> {
    const rows = await getRepository(MappingOverride).find({
      where: {
        fromNamespace: from.ns,
        fromExternalId: String(from.id),
        fromSeason: seasonColumn(from.season),
        toNamespace: to,
      },
    });
    return rows
      .filter((row) => row.toExternalId)
      .map((row) => ({
        target: {
          ns: row.toNamespace,
          id: row.toExternalId,
          ...(seasonValue(row.toSeason) === undefined
            ? {}
            : { season: seasonValue(row.toSeason) as number }),
        },
        confidence: 100,
        sourceKey: 'override',
      }));
  }

  /**
   * Was this pairing explicitly overridden to "does not exist"? An empty
   * `toExternalId` is how an admin records a genuine absence, and it must stop
   * the chain rather than fall through to a live resolver every render.
   */
  private async isDeniedByOverride(
    from: IdRef,
    to: Namespace
  ): Promise<boolean> {
    const denial = await getRepository(MappingOverride).findOne({
      where: {
        fromNamespace: from.ns,
        fromExternalId: String(from.id),
        fromSeason: seasonColumn(from.season),
        toNamespace: to,
        toExternalId: '',
      },
    });
    return Boolean(denial);
  }

  private async runLayer(
    kind: ResolverKind,
    from: IdRef,
    to: Namespace,
    options: ResolveOptions
  ): Promise<MappingCandidate[]> {
    if (kind === 'override') return this.resolveOverride(from, to);
    if (kind === 'graph') return resolveFromGraph(from, to);
    if (kind === 'live' && options.offline) return [];

    const context: ResolverContext = {
      title: options.title,
      year: options.year,
      mediaType: options.mediaType,
      episodeCount: options.episodeCount,
      discoverSource: options.discoverSource,
    };
    const candidates: MappingCandidate[] = [];
    for (const resolver of this.resolversFor(kind)) {
      if (!resolver.supports(from, to)) continue;
      try {
        candidates.push(...(await resolver.resolve(from, to, context)));
      } catch (error) {
        logger.debug('Mapping resolver failed', {
          label: 'Mapping',
          resolver: resolver.key,
          from: refKey(from),
          to,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
      // Two independent sources agreeing is the acceptance rule, so keep
      // querying siblings in this layer until corroboration is possible.
      if (distinctWorks(candidates) === 1 && candidates.length >= 2) break;
    }
    return collapseSeasonVariants(candidates);
  }

  /**
   * Persist a pack or live result into the graph so the next lookup is a single
   * indexed query. Heuristic results are deliberately never persisted: L4 writes
   * only to the review queue, which is the guard the reverted title-matching
   * commit lacked.
   */
  private async persist(
    from: IdRef,
    best: MappingCandidate,
    options: ResolveOptions
  ): Promise<void> {
    try {
      await upsertCluster(
        [
          { ref: from, confidence: best.confidence, sourceKey: best.sourceKey },
          {
            ref: best.target,
            confidence: best.confidence,
            sourceKey: best.sourceKey,
          },
        ],
        { title: options.title, year: options.year }
      );
    } catch (error) {
      logger.debug('Unable to persist mapping', {
        label: 'Mapping',
        from: refKey(from),
        to: refKey(best.target),
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public async resolve(
    from: IdRef,
    to: Namespace,
    options: ResolveOptions = {}
  ): Promise<MappingResolution> {
    if (!isNamespace(from.ns) || !isNamespace(to) || !from.id) return NOT_FOUND;
    if (from.ns === to && from.season === undefined) {
      return {
        target: from,
        confidence: 100,
        sourceKey: 'identity',
        candidates: [{ target: from, confidence: 100, sourceKey: 'identity' }],
        ambiguous: false,
        layer: 'cache',
      };
    }

    const cacheKey = `${refKey(from)}->${to}${options.offline ? '|offline' : ''}`;
    const cached = this.hot.get(cacheKey);
    if (cached) return cached;

    const startAt = LAYER_ORDER.indexOf(options.minKind ?? 'override');
    const layers = LAYER_ORDER.slice(Math.max(0, startAt));

    if (
      layers.includes('override') &&
      (await this.isDeniedByOverride(from, to))
    ) {
      const denied: MappingResolution = {
        ...NOT_FOUND,
        sourceKey: 'override',
        layer: 'override',
      };
      this.hot.set(cacheKey, denied);
      return denied;
    }

    for (const layer of layers) {
      const candidates = await this.runLayer(layer, from, to, options);
      if (!candidates.length) continue;

      const ranked = [...candidates].sort(
        (a, b) => b.confidence - a.confidence
      );
      const ambiguous = distinctWorks(candidates) > 1;

      // An unresolved ambiguity is a reviewable question, never a silent write.
      if (ambiguous && layer !== 'override') {
        const byTitle = options.title
          ? await pickByTitle(ranked, options.title)
          : undefined;
        if (byTitle) {
          const resolution: MappingResolution = {
            target: byTitle.target,
            confidence: byTitle.confidence,
            sourceKey: byTitle.sourceKey,
            candidates: ranked,
            ambiguous: false,
            layer,
          };
          this.hot.set(cacheKey, resolution);
          return resolution;
        }
        // Franchise mega-clusters often poison the graph; pack/live may still
        // have a clean per-work answer (e.g. animeapi's Infinity Castle row).
        if (layer === 'graph') continue;

        const resolution: MappingResolution = {
          confidence: 0,
          sourceKey: ranked[0].sourceKey,
          candidates: ranked,
          ambiguous: true,
          layer,
        };
        if (!options.silent) this.recordGap(from, to, options, 'ambiguous');
        this.hot.set(cacheKey, resolution);
        return resolution;
      }

      const best = ranked[0];
      if (layer === 'pack' || layer === 'live') {
        await this.persist(from, best, options);
      }

      const resolution: MappingResolution = {
        target: best.target,
        confidence: best.confidence,
        sourceKey: best.sourceKey,
        candidates: ranked,
        ambiguous: false,
        layer,
      };
      // Heuristic candidates are surfaced for review but never returned as a
      // trusted answer.
      if (layer === 'heuristic') {
        const quarantined: MappingResolution = {
          ...resolution,
          target: undefined,
          confidence: 0,
        };
        if (!options.silent) this.recordGap(from, to, options, 'ambiguous');
        this.hot.set(cacheKey, quarantined);
        return quarantined;
      }
      this.hot.set(cacheKey, resolution);
      return resolution;
    }

    if (!options.silent) this.recordGap(from, to, options, 'unresolved');
    this.hot.set(cacheKey, NOT_FOUND);
    return NOT_FOUND;
  }

  private recordGap(
    from: IdRef,
    to: Namespace,
    options: ResolveOptions,
    reason: 'unresolved' | 'ambiguous'
  ): void {
    recordMappingGap({
      namespace: from.ns,
      externalId: String(from.id),
      season: from.season,
      title: options.title,
      year: options.year,
      mediaType: options.mediaType,
      discoverSource: options.discoverSource,
      reason,
      sourceKey: `resolve->${to}`,
    });
  }

  /** Resolve several ids of one namespace, de-duplicating repeated ids. */
  public async resolveMany(
    from: IdRef[],
    to: Namespace,
    options: ResolveOptions = {}
  ): Promise<Map<string, MappingResolution>> {
    const results = new Map<string, MappingResolution>();
    for (const ref of from) {
      const key = refKey(ref);
      if (results.has(key)) continue;
      results.set(key, await this.resolve(ref, to, options));
    }
    return results;
  }
}

const mappingService = new MappingService();
export default mappingService;
