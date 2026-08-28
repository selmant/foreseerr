import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbEpisodeGroupType,
  TmdbTvEpisodeGroupDetails,
} from '@server/api/themoviedb/interfaces';
import logger from '@server/logger';
import { withBudget } from './budget';
import { formatEpisodeRange, upsertEpisodeRule } from './episodes';
import { findClusterIds, upsertCluster } from './graph';
import type { IdRef, Namespace } from './types';

export const EPISODE_GROUP_TYPES = {
  originalAirDate: 1,
  absolute: 2,
  dvd: 3,
  digital: 4,
  storyArc: 5,
  production: 6,
  tv: 7,
} as const satisfies Record<string, TmdbEpisodeGroupType>;

/**
 * The namespace an ordering is stored under.
 *
 * Absolute order is the one Sonarr needs for anime, so it gets its own
 * pseudo-namespace rather than being flattened into the TMDB season order it
 * deliberately differs from.
 */
export const ORDER_NAMESPACE: Namespace = 'tmdb_show';

export interface DerivedEpisodeRule {
  sourceSeason: number;
  sourceRange: string;
  targetSeason: number;
  targetRange: string;
  ratio: number;
}

interface Coordinate {
  order: number;
  season: number;
  episode: number;
}

/**
 * Collapse a per-episode list into contiguous ranges.
 *
 * A show with 1,264 episodes must not produce 1,264 rows: consecutive episodes
 * that keep the same season and stay in step compress into one range, which is
 * how the same data fits in a handful of rules.
 */
export function compressToRules(
  coordinates: Coordinate[],
  groupSeason: number
): DerivedEpisodeRule[] {
  const sorted = [...coordinates].sort((a, b) => a.order - b.order);
  const rules: DerivedEpisodeRule[] = [];
  let run: { from: Coordinate; to: Coordinate } | undefined;

  const flush = () => {
    if (!run) return;
    rules.push({
      sourceSeason: groupSeason,
      sourceRange: formatEpisodeRange({
        start: run.from.order,
        end: run.to.order,
      }),
      targetSeason: run.from.season,
      targetRange: formatEpisodeRange({
        start: run.from.episode,
        end: run.to.episode,
      }),
      ratio: 1,
    });
    run = undefined;
  };

  for (const coordinate of sorted) {
    if (
      run &&
      coordinate.season === run.to.season &&
      coordinate.order === run.to.order + 1 &&
      coordinate.episode === run.to.episode + 1
    ) {
      run.to = coordinate;
      continue;
    }
    flush();
    run = { from: coordinate, to: coordinate };
  }
  flush();
  return rules;
}

/**
 * Turn one TMDB episode group into rules from its ordering onto TMDB's own
 * season/episode numbers.
 */
export function rulesFromEpisodeGroup(
  details: TmdbTvEpisodeGroupDetails
): DerivedEpisodeRule[] {
  const rules: DerivedEpisodeRule[] = [];
  const groups = [...details.groups].sort((a, b) => a.order - b.order);

  for (const group of groups) {
    const coordinates: Coordinate[] = group.episodes
      .filter(
        (episode) =>
          Number.isInteger(episode.season_number) &&
          Number.isInteger(episode.episode_number)
      )
      // TMDB's `order` is zero-based within the group; episode numbers are not.
      .map((episode, index) => ({
        order: (Number.isInteger(episode.order) ? episode.order : index) + 1,
        season: episode.season_number,
        episode: episode.episode_number,
      }));
    // The group's own "season" is its 1-based position, except for absolute
    // order where the whole show is a single stream.
    const groupSeason =
      details.type === EPISODE_GROUP_TYPES.absolute ? 1 : group.order + 1;
    rules.push(...compressToRules(coordinates, groupSeason));
  }

  return rules;
}

const confidenceForType = (type: TmdbEpisodeGroupType): number =>
  // TMDB publishes these itself, so they outrank any third-party pack, but the
  // absolute order is the only one Sonarr consumes directly.
  type === EPISODE_GROUP_TYPES.absolute ? 95 : 90;

export interface EpisodeGroupImport {
  tmdbId: number;
  groups: number;
  rules: number;
}

/**
 * Import every published ordering for a show into the episode rule table.
 *
 * Applies to any show, not only anime: `Yellowstone`-style split seasons and
 * DVD-order reissues hit exactly the same numbering mismatch.
 */
export async function importEpisodeGroups(
  tmdbId: number,
  {
    types,
    tmdb = new TheMovieDb(),
  }: { types?: TmdbEpisodeGroupType[]; tmdb?: TheMovieDb } = {}
): Promise<EpisodeGroupImport> {
  const result: EpisodeGroupImport = { tmdbId, groups: 0, rules: 0 };
  const showRef: IdRef = { ns: 'tmdb_show', id: String(tmdbId) };

  let summaries;
  try {
    summaries = await withBudget('tmdb-find', 'bulk', () =>
      tmdb.getTvEpisodeGroups({ tvId: tmdbId })
    );
  } catch (error) {
    logger.debug('Unable to list TMDB episode groups', {
      label: 'Mapping',
      tmdbId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return result;
  }

  const wanted = summaries.results.filter(
    (summary) => !types || types.includes(summary.type)
  );
  if (!wanted.length) return result;

  const clusterId =
    (await findClusterIds(showRef))[0] ??
    (await upsertCluster([
      { ref: showRef, confidence: 100, sourceKey: 'tmdb-episode-groups' },
    ]));
  if (clusterId === undefined) return result;

  for (const summary of wanted) {
    let details: TmdbTvEpisodeGroupDetails;
    try {
      details = await withBudget('tmdb-find', 'bulk', () =>
        tmdb.getTvEpisodeGroup({ groupId: summary.id })
      );
    } catch (error) {
      logger.debug('Unable to fetch TMDB episode group', {
        label: 'Mapping',
        groupId: summary.id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    result.groups += 1;
    const sourceKey = `tmdb-episode-group:${summary.type}:${summary.id}`;
    for (const rule of rulesFromEpisodeGroup(details)) {
      await upsertEpisodeRule({
        clusterId,
        source: {
          ns: ORDER_NAMESPACE,
          id: String(tmdbId),
          season: rule.sourceSeason,
        },
        target: {
          ns: ORDER_NAMESPACE,
          id: String(tmdbId),
          season: rule.targetSeason,
        },
        sourceRange: rule.sourceRange,
        targetRange: rule.targetRange,
        ratio: rule.ratio,
        confidence: confidenceForType(summary.type),
        sourceKey,
      });
      result.rules += 1;
    }
  }

  return result;
}
