import logger from '@server/logger';
import { edgesFrom, edgesTo, type Edge } from './edges';
import {
  refKey,
  scopeSeason,
  seasonScope,
  type IdRef,
  type Namespace,
} from './types';

export interface EpisodeRange {
  start: number;
  /** Undefined for an open-ended range such as `13-`. */
  end?: number;
}

export interface EpisodeRule {
  source: IdRef;
  target: IdRef;
  sourceRange: EpisodeRange;
  targetRange: EpisodeRange;
  /** Source episodes consumed per target episode; 1 for a plain offset. */
  ratio: number;
  /** Target episodes produced per source episode; the first one is returned. */
  expand?: number;
  dataset: string;
}

export interface EpisodeTranslation {
  target: IdRef;
  season: number;
  episode: number;
  dataset: string;
}

/**
 * Parse `1-13`, `13-`, `5`, or `-13`.
 *
 * Open-ended ranges cover an ongoing cour (`"14-": "14-"`), so an unparsed
 * tail must stay unbounded rather than collapse to a single episode.
 */
export function parseEpisodeRange(range: string): EpisodeRange | undefined {
  const text = String(range ?? '').trim();
  if (!text) return undefined;
  const match = text.match(/^(\d+)?\s*-\s*(\d+)?$/);
  if (match) {
    const start = match[1] === undefined ? 1 : Number(match[1]);
    const end = match[2] === undefined ? undefined : Number(match[2]);
    if (!Number.isFinite(start)) return undefined;
    if (end !== undefined && (!Number.isFinite(end) || end < start)) {
      return undefined;
    }
    return end === undefined ? { start } : { start, end };
  }
  const single = Number(text);
  if (!Number.isInteger(single) || single < 0) return undefined;
  return { start: single, end: single };
}

const rangeContains = (range: EpisodeRange, episode: number): boolean =>
  episode >= range.start && (range.end === undefined || episode <= range.end);

const rangeLength = (range: EpisodeRange): number | undefined =>
  range.end === undefined ? undefined : range.end - range.start + 1;

/**
 * Translate one episode number through a rule.
 *
 * `ratio` is source episodes per target episode: a 2:1 rule folds a two-part
 * broadcast into one catalogue entry, which is why the division is floored on
 * the offset rather than applied to the absolute number.
 */
export function applyEpisodeRule(
  rule: Pick<EpisodeRule, 'sourceRange' | 'targetRange' | 'ratio' | 'expand'>,
  episode: number
): number | undefined {
  if (!rangeContains(rule.sourceRange, episode)) return undefined;
  const offset = episode - rule.sourceRange.start;
  const ratio = rule.ratio > 0 ? rule.ratio : 1;
  const expand = rule.expand && rule.expand > 0 ? rule.expand : 1;
  const mapped = rule.targetRange.start + Math.floor(offset / ratio) * expand;
  if (rule.targetRange.end !== undefined && mapped > rule.targetRange.end) {
    return undefined;
  }
  return mapped;
}

type RangeRule = Pick<
  EpisodeRule,
  'sourceRange' | 'targetRange' | 'ratio' | 'expand'
>;

/**
 * Read one stored range pair.
 *
 * The target side may carry a ratio (`1-2|2` folds two source episodes into
 * each target, `1-12|-4` expands each source into four) or list discontiguous
 * runs (`1-15,17-22`), which are filled from the source range in order.
 */
export function parseRangePair(
  sourceRange: string,
  targetRange: string
): RangeRule[] {
  const source = parseEpisodeRange(sourceRange);
  if (!source) return [];
  const [rangePart, ratioPart] = targetRange.split('|');
  const signed = Number(ratioPart);
  const scaling =
    Number.isInteger(signed) && signed > 1
      ? { ratio: signed }
      : Number.isInteger(signed) && signed < -1
        ? { ratio: 1, expand: -signed }
        : { ratio: 1 };

  const segments = rangePart.split(',').map(parseEpisodeRange);
  if (segments.some((segment) => !segment)) return [];
  const targets = segments as EpisodeRange[];
  if (targets.length === 1) {
    return [{ sourceRange: source, targetRange: targets[0], ...scaling }];
  }

  // Splitting a scaled range across runs has no single reading.
  if (ratioPart !== undefined) return [];
  const rules: RangeRule[] = [];
  let start = source.start;
  for (const target of targets) {
    const length = rangeLength(target);
    if (length === undefined) return [];
    rules.push({
      sourceRange: { start, end: start + length - 1 },
      targetRange: target,
      ratio: 1,
    });
    start += length;
  }
  return rules;
}

const refOf = (ns: string, id: string, scope: string): IdRef => {
  const season = scopeSeason(scope);
  return {
    ns: ns as Namespace,
    id,
    ...(season === undefined ? {} : { season }),
  };
};

interface ScopedRule extends EpisodeRule {
  targetScope: string;
}

const rulesOf = (edges: Edge[], to: Namespace): ScopedRule[] =>
  edgesTo(
    edges.filter((edge) => edge.srcRange && edge.dstRange),
    to
  ).flatMap((edge) =>
    parseRangePair(edge.srcRange as string, edge.dstRange as string).map(
      (rule) => ({
        ...rule,
        source: refOf(edge.srcNs, edge.srcId, edge.srcScope),
        target: refOf(edge.dstNs, edge.dstId, edge.dstScope),
        targetScope: edge.dstScope,
        dataset: edge.dataset,
      })
    )
  );

/** Edges for a coordinate: its season, or for AniDB its regular episodes. */
async function scopedEdges(from: IdRef, scope?: string): Promise<Edge[]> {
  const edges = await edgesFrom(from.ns, String(from.id));
  const wanted =
    scope ??
    (from.season !== undefined
      ? seasonScope(from.season)
      : from.ns === 'anidb'
        ? 'R'
        : undefined);
  return wanted === undefined
    ? edges
    : edges.filter((edge) => edge.srcScope === wanted);
}

/**
 * Every stated range that could translate `from` into `to`.
 *
 * Datasets state both directions, so there is nothing to invert: a question
 * about `tmdb_show:1429:s1` reads that descriptor's own edges.
 */
export async function findEpisodeRules(
  from: IdRef,
  to: Namespace
): Promise<EpisodeRule[]> {
  return rulesOf(await scopedEdges(from), to);
}

interface ScopedTranslation extends EpisodeTranslation {
  targetScope: string;
}

async function translate(
  from: IdRef & { episode: number },
  to: Namespace,
  scope?: string
): Promise<ScopedTranslation[]> {
  const results: ScopedTranslation[] = [];
  const seen = new Set<string>();
  for (const rule of rulesOf(await scopedEdges(from, scope), to)) {
    const episode = applyEpisodeRule(rule, from.episode);
    if (episode === undefined) continue;
    const season = rule.target.season ?? from.season ?? 1;
    const key = `${refKey(rule.target)}:${rule.targetScope}:e${episode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      target: rule.target,
      targetScope: rule.targetScope,
      season,
      episode,
      dataset: rule.dataset,
    });
  }
  return results;
}

async function translateOnce(
  from: IdRef & { episode: number },
  to: Namespace,
  scope?: string
): Promise<ScopedTranslation | undefined> {
  const results = await translate(from, to, scope);
  if (!results.length) return undefined;
  const distinct = new Set(
    results.map(
      (result) => `${result.target.id}:${result.season}:${result.episode}`
    )
  );
  if (distinct.size > 1) {
    logger.debug('Ambiguous episode translation', {
      label: 'Mapping',
      from: refKey(from),
      episode: from.episode,
      to,
      candidates: [...distinct],
    });
    return undefined;
  }
  return results[0];
}

/**
 * Translate a season+episode coordinate into another namespace.
 *
 * Not anime-gated: split seasons and alternate orders are just as common on
 * non-anime shows, and gating on an anime flag is precisely why a TMDB split
 * season silently mis-numbered.
 */
export const translateEpisode = (
  from: IdRef & { episode: number },
  to: Namespace
): Promise<EpisodeTranslation[]> => translate(from, to);

/** The single best translation, or undefined when the ranges disagree. */
export const translateEpisodeOnce = (
  from: IdRef & { episode: number },
  to: Namespace
): Promise<EpisodeTranslation | undefined> => translateOnce(from, to);

/**
 * Translate through an intermediate namespace when no direct range exists.
 *
 * The primary dataset states most pairs directly; this covers the rest by
 * going through the anime entry both sides are stated against.
 */
export async function translateEpisodeBridged(
  from: IdRef & { episode: number },
  to: Namespace,
  bridges: Namespace[] = []
): Promise<EpisodeTranslation | undefined> {
  const direct = await translateOnce(from, to);
  if (direct) return direct;

  for (const bridge of bridges) {
    if (bridge === to || bridge === from.ns) continue;
    const hop = await translateOnce(from, bridge);
    if (!hop) continue;
    const landed = await translateOnce(
      { ...hop.target, episode: hop.episode },
      to,
      hop.targetScope
    );
    if (landed) {
      return {
        ...landed,
        dataset: `${hop.dataset}+${landed.dataset}`,
      };
    }
  }
  return undefined;
}
