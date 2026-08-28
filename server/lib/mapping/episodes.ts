import { getRepository } from '@server/datasource';
import { MappingEpisodeRule } from '@server/entity/MappingEpisodeRule';
import logger from '@server/logger';
import { In } from 'typeorm';
import { findClusterIds } from './graph';
import mappingService from './service';
import {
  refKey,
  seasonColumn,
  seasonValue,
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
  /**
   * Target episodes produced per source episode, set only when a rule is
   * inverted. A 2:1 fold read backwards yields the first of the pair.
   */
  expand?: number;
  confidence: number;
  sourceKey: string;
}

export interface EpisodeTranslation {
  target: IdRef;
  season: number;
  episode: number;
  confidence: number;
  sourceKey: string;
}

/**
 * Parse `1-13`, `13-`, `5`, or `-13`.
 *
 * Open-ended ranges are the norm in anibridge (`"14-": "14-"` covers an
 * ongoing cour), so an unparsed tail must stay unbounded rather than collapse
 * to a single episode.
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

export const formatEpisodeRange = (range: EpisodeRange): string =>
  range.end === undefined
    ? `${range.start}-`
    : range.end === range.start
      ? String(range.start)
      : `${range.start}-${range.end}`;

const rangeContains = (range: EpisodeRange, episode: number): boolean =>
  episode >= range.start && (range.end === undefined || episode <= range.end);

/**
 * Translate one episode number through a rule.
 *
 * `ratio` is source episodes per target episode: a 2:1 rule folds a two-part
 * broadcast into one catalogue entry, which is why the division is floored on
 * the offset rather than applied to the absolute number.
 */
export function applyEpisodeRule(
  rule: EpisodeRule,
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

/**
 * Read a rule backwards.
 *
 * Packs only ever state one direction (anibridge maps AniDB onto TMDB), but the
 * read path always asks the other way round: a user clicks TMDB S1E70 and the
 * answer has to be an AniDB episode number.
 */
export function invertEpisodeRule(rule: EpisodeRule): EpisodeRule {
  return {
    source: rule.target,
    target: rule.source,
    sourceRange: rule.targetRange,
    targetRange: rule.sourceRange,
    ratio: 1,
    ...(rule.ratio > 1 ? { expand: rule.ratio } : {}),
    confidence: rule.confidence,
    sourceKey: `${rule.sourceKey}:inverted`,
  };
}

const toRule = (row: MappingEpisodeRule): EpisodeRule | undefined => {
  const sourceRange = parseEpisodeRange(row.sourceRange);
  const targetRange = parseEpisodeRange(row.targetRange);
  if (!sourceRange || !targetRange) return undefined;
  const sourceSeason = seasonValue(row.sourceSeason);
  const targetSeason = seasonValue(row.targetSeason);
  return {
    source: {
      ns: row.sourceNamespace,
      id: row.sourceExternalId ?? '',
      ...(sourceSeason === undefined ? {} : { season: sourceSeason }),
    },
    target: {
      ns: row.targetNamespace,
      id: row.targetExternalId ?? '',
      ...(targetSeason === undefined ? {} : { season: targetSeason }),
    },
    sourceRange,
    targetRange,
    ratio: row.ratio,
    confidence: row.confidence,
    sourceKey: row.sourceKey,
  };
};

/**
 * Every stored rule that could translate `from` into `to`.
 *
 * A rule with an empty `sourceExternalId` applies to any id of that namespace in
 * the cluster, which is how a pack expresses "this show's season 2 starts at
 * absolute 26" without repeating the id on every row.
 */
export async function findEpisodeRules(
  from: IdRef,
  to: Namespace
): Promise<EpisodeRule[]> {
  const clusterIds = await findClusterIds(from);
  if (!clusterIds.length) return [];
  const repository = getRepository(MappingEpisodeRule);
  const [forwardRows, reverseRows] = await Promise.all([
    repository.find({
      where: {
        clusterId: In(clusterIds),
        sourceNamespace: from.ns,
        targetNamespace: to,
      },
    }),
    repository.find({
      where: {
        clusterId: In(clusterIds),
        sourceNamespace: to,
        targetNamespace: from.ns,
      },
    }),
  ]);

  const forward = forwardRows
    .map(toRule)
    .filter((rule): rule is EpisodeRule => rule !== undefined);
  const reverse = reverseRows
    .map(toRule)
    .filter((rule): rule is EpisodeRule => rule !== undefined)
    .map(invertEpisodeRule);

  return [...forward, ...reverse]
    .filter((rule) => !rule.source.id || rule.source.id === String(from.id))
    .filter(
      (rule) =>
        from.season === undefined ||
        rule.source.season === undefined ||
        rule.source.season === from.season
    )
    .sort((a, b) => b.confidence - a.confidence);
}

/**
 * Translate a season+episode coordinate into another namespace.
 *
 * Not anime-gated: split seasons and alternate orders are just as common on
 * non-anime shows, and gating on an anime flag is precisely why a TMDB split
 * season silently mis-numbered.
 */
export async function translateEpisode(
  from: IdRef & { episode: number },
  to: Namespace
): Promise<EpisodeTranslation[]> {
  const rules = await findEpisodeRules(from, to);
  const results: EpisodeTranslation[] = [];
  const seen = new Set<string>();

  for (const rule of rules) {
    const episode = applyEpisodeRule(rule, from.episode);
    if (episode === undefined) continue;
    const season = rule.target.season ?? from.season ?? 1;
    const target: IdRef = {
      ns: rule.target.ns,
      id: rule.target.id || String(from.id),
      season,
      episode,
    };
    const key = `${refKey(target)}:e${episode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      target,
      season,
      episode,
      confidence: rule.confidence,
      sourceKey: rule.sourceKey,
    });
  }

  return results;
}

/** The single best translation, or undefined when rules disagree. */
export async function translateEpisodeOnce(
  from: IdRef & { episode: number },
  to: Namespace
): Promise<EpisodeTranslation | undefined> {
  const results = await translateEpisode(from, to);
  if (!results.length) return undefined;
  const distinct = new Set(
    results.map((result) => `${result.season}:${result.episode}`)
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
 * Translate through an intermediate namespace when no direct rule exists.
 *
 * Anime packs state their ranges against AniDB, so an AniList question has to
 * hop AniDB first; doing that hop here keeps the bridging in one place instead of
 * in each media-action module.
 */
export async function translateEpisodeBridged(
  from: IdRef & { episode: number },
  to: Namespace,
  bridges: Namespace[] = []
): Promise<EpisodeTranslation | undefined> {
  const direct = await translateEpisodeOnce(from, to);
  if (direct) return direct;

  for (const bridge of bridges) {
    if (bridge === to || bridge === from.ns) continue;
    const hop = await translateEpisodeOnce(from, bridge);
    if (!hop) continue;
    const resolution = await mappingService.resolve(
      {
        ns: bridge,
        id: hop.target.id,
        ...(hop.season ? { season: hop.season } : {}),
      },
      to,
      { silent: true }
    );
    if (!resolution.target?.id) continue;
    return {
      target: { ...resolution.target, episode: hop.episode },
      season: hop.season,
      episode: hop.episode,
      confidence: Math.min(hop.confidence, resolution.confidence),
      sourceKey: `${hop.sourceKey}+${resolution.sourceKey}`,
    };
  }

  return undefined;
}

/**
 * Rules that place something at a specific episode of a TVDB season.
 *
 * Queried by target rather than by source because the caller only knows where
 * the file sits (series X, specials, episode 4) and is asking what it *is*.
 */
export async function findRulesByTarget(
  target: IdRef,
  episode: number
): Promise<EpisodeRule[]> {
  const rows = await getRepository(MappingEpisodeRule).find({
    where: {
      targetNamespace: target.ns,
      targetExternalId: String(target.id),
      targetSeason: seasonColumn(target.season),
    },
  });
  return rows
    .map(toRule)
    .filter((rule): rule is EpisodeRule => rule !== undefined)
    .filter((rule) => rangeContains(rule.targetRange, episode))
    .sort((a, b) => b.confidence - a.confidence);
}

export interface UpsertEpisodeRule {
  clusterId: number;
  source: IdRef;
  target: IdRef;
  sourceRange: string;
  targetRange: string;
  ratio: number;
  confidence: number;
  sourceKey: string;
}

/** Store an episode rule, keeping the highest-confidence version of a row. */
export async function upsertEpisodeRule(
  rule: UpsertEpisodeRule
): Promise<void> {
  const repository = getRepository(MappingEpisodeRule);
  // An empty string, not NULL, marks "applies to any id in this cluster": the
  // identity lookup below has to be able to match it.
  const identity = {
    clusterId: rule.clusterId,
    sourceNamespace: rule.source.ns,
    sourceExternalId: String(rule.source.id ?? ''),
    sourceSeason: seasonColumn(rule.source.season),
    sourceRange: rule.sourceRange,
    targetNamespace: rule.target.ns,
    targetExternalId: String(rule.target.id ?? ''),
    targetSeason: seasonColumn(rule.target.season),
  };
  const existing = await repository.findOne({ where: identity });
  const now = new Date();
  if (!existing) {
    await repository.insert({
      ...identity,
      targetRange: rule.targetRange,
      ratio: rule.ratio,
      confidence: rule.confidence,
      sourceKey: rule.sourceKey,
      updatedAt: now,
    });
    return;
  }
  if (rule.confidence > existing.confidence) {
    await repository.update(existing.id, {
      targetRange: rule.targetRange,
      ratio: rule.ratio,
      confidence: rule.confidence,
      sourceKey: rule.sourceKey,
      updatedAt: now,
    });
  }
}

export interface SeasonEpisodeCount {
  seasonNumber: number;
  episodeCount: number;
}

/**
 * Absolute episode number from in-season coordinates, using real season lengths.
 *
 * Season 0 is excluded: specials are not part of the absolute order, and
 * counting them shifts every subsequent episode.
 */
export function absoluteFromSeasons(
  seasons: SeasonEpisodeCount[],
  seasonNumber: number,
  episodeNumber: number
): number | undefined {
  if (seasonNumber < 1 || episodeNumber < 1) return undefined;
  let absolute = episodeNumber;
  for (const season of seasons) {
    if (season.seasonNumber < 1 || season.seasonNumber >= seasonNumber)
      continue;
    absolute += Math.max(0, season.episodeCount);
  }
  const wanted = seasons.find((season) => season.seasonNumber === seasonNumber);
  if (wanted && episodeNumber > wanted.episodeCount) return undefined;
  return absolute;
}

/** The inverse of {@link absoluteFromSeasons}. */
export function seasonsFromAbsolute(
  seasons: SeasonEpisodeCount[],
  absolute: number
): { seasonNumber: number; episodeNumber: number } | undefined {
  if (absolute < 1) return undefined;
  let remaining = absolute;
  for (const season of [...seasons]
    .filter((season) => season.seasonNumber >= 1)
    .sort((a, b) => a.seasonNumber - b.seasonNumber)) {
    if (remaining <= season.episodeCount) {
      return {
        seasonNumber: season.seasonNumber,
        episodeNumber: remaining,
      };
    }
    remaining -= season.episodeCount;
  }
  return undefined;
}
