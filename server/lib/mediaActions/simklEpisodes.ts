import { ensureMappingLayer } from '@server/lib/mapping/bootstrap';
import {
  applyEpisodeRule,
  findEpisodeRules,
  translateEpisodeBridged,
} from '@server/lib/mapping/episodes';
import mappingService from '@server/lib/mapping/service';
import { createSimklUserClient } from '@server/lib/simkl';
import { syncSimklUser } from '@server/lib/simklSync';
import { SimklMediaActionProvider } from './simkl';

const provider = new SimklMediaActionProvider();

interface SimklCoordinates {
  ids: { simkl?: string; tmdb?: number; tvdb?: number; anidb?: number };
  season: number;
  episode: number;
}

/**
 * The ids and numbering to write against, resolved rather than assumed.
 *
 * Simkl stores anime under TVDB's season layout, so a TMDB coordinate has to be
 * translated before it is written. Where the mapping layer has no rule the TMDB
 * numbers are sent unchanged, which is at least self-consistent with what the UI
 * showed.
 */
async function simklCoordinates(
  tmdbId: number,
  seasonNumber: number,
  episodeNumber: number
): Promise<SimklCoordinates> {
  await ensureMappingLayer();
  const from = {
    ns: 'tmdb_show' as const,
    id: String(tmdbId),
    season: seasonNumber,
    episode: episodeNumber,
  };

  const [simkl, tvdb, anidb] = await Promise.all([
    mappingService.resolve(
      { ns: 'tmdb_show', id: String(tmdbId), season: seasonNumber },
      'simkl',
      { silent: true }
    ),
    translateEpisodeBridged(from, 'tvdb_show', ['anidb']),
    translateEpisodeBridged(from, 'anidb'),
  ]);

  const ids: SimklCoordinates['ids'] = { tmdb: tmdbId };
  if (simkl.target?.id) ids.simkl = simkl.target.id;
  if (tvdb?.target.id) ids.tvdb = Number(tvdb.target.id) || undefined;
  if (anidb?.target.id) ids.anidb = Number(anidb.target.id) || undefined;

  // TVDB numbering is what Simkl itself indexes anime by, so prefer it when a
  // rule produced it; otherwise stay in TMDB's numbering.
  return tvdb
    ? { ids, season: tvdb.season, episode: tvdb.episode }
    : { ids, season: seasonNumber, episode: episodeNumber };
}

export interface WatchedCoordinate {
  season: number;
  episode: number;
}

/** Every watched episode Simkl reports for a show, in Simkl's own numbering. */
export const watchedCoordinates = (
  payload: Record<string, unknown>,
  tmdbId: number
): WatchedCoordinate[] => {
  const shows = Object.values(payload).flatMap((value) =>
    Array.isArray(value) ? value : []
  );
  const show = shows.find((value) => {
    if (!value || typeof value !== 'object') return false;
    const ids = (value as { ids?: { tmdb?: unknown } }).ids;
    return Number(ids?.tmdb) === tmdbId;
  }) as
    | {
        seasons?: {
          number?: unknown;
          episodes?: { number?: unknown; watched_at?: unknown }[];
        }[];
      }
    | undefined;

  return (show?.seasons ?? []).flatMap((season) => {
    const seasonNumber = Number(season.number);
    if (!Number.isInteger(seasonNumber) || seasonNumber < 0) return [];
    return (season.episodes ?? [])
      .filter((episode) => episode.watched_at !== undefined)
      .map((episode) => Number(episode.number))
      .filter((number) => Number.isInteger(number) && number > 0)
      .map((episode) => ({ season: seasonNumber, episode }));
  });
};

/**
 * Fold Simkl's coordinates back into TMDB numbering for one season.
 *
 * Simkl may be storing TVDB anime seasons, so an episode watched as S2E1 there
 * can be S1E14 on TMDB. Coordinates that already sit in the requested season are
 * kept as-is, which covers every show without a rule.
 */
async function tmdbEpisodeNumbers(
  tmdbId: number,
  seasonNumber: number,
  coordinates: WatchedCoordinate[]
): Promise<number[]> {
  if (!coordinates.length) return [];
  const rules = await findEpisodeRules(
    { ns: 'tmdb_show', id: String(tmdbId), season: seasonNumber },
    'tvdb_show'
  );
  const direct = coordinates
    .filter((coordinate) => coordinate.season === seasonNumber)
    .map((coordinate) => coordinate.episode);
  if (!rules.length) {
    return [...new Set(direct)].sort((left, right) => left - right);
  }

  const watched = new Set<number>();
  const bySimkl = new Map(
    coordinates.map((coordinate) => [
      `${coordinate.season}:${coordinate.episode}`,
      coordinate,
    ])
  );
  for (const rule of rules) {
    const start = rule.sourceRange.start;
    const end = rule.sourceRange.end ?? start + 500;
    for (let episode = start; episode <= end; episode += 1) {
      const mapped = applyEpisodeRule(rule, episode);
      if (mapped === undefined) continue;
      const season = rule.target.season ?? seasonNumber;
      if (bySimkl.has(`${season}:${mapped}`)) watched.add(episode);
    }
  }
  return [...watched].sort((left, right) => left - right);
}

export const simklEpisodeActions = {
  isAvailable: (userId: number) => provider.isAvailable(userId),
  async getSeasonStatus(userId: number, tmdbId: number, seasonNumber: number) {
    if (!(await provider.isAvailable(userId)))
      return { available: false, watchedEpisodeNumbers: [] };
    const client = await createSimklUserClient(userId);
    const coordinates = watchedCoordinates(
      await client.getWatchedEpisodes(),
      tmdbId
    );
    return {
      available: true,
      watchedEpisodeNumbers: await tmdbEpisodeNumbers(
        tmdbId,
        seasonNumber,
        coordinates
      ),
    };
  },
  async setWatched(
    userId: number,
    tmdbId: number,
    seasonNumber: number,
    episodeNumber: number,
    watched: boolean
  ) {
    if (
      !(await provider.isAvailable(userId)) ||
      seasonNumber < 0 ||
      episodeNumber < 1
    )
      return false;
    const coordinates = await simklCoordinates(
      tmdbId,
      seasonNumber,
      episodeNumber
    );
    await (
      await createSimklUserClient(userId)
    ).setEpisodeHistory(
      coordinates.ids,
      coordinates.season,
      coordinates.episode,
      watched
    );
    await syncSimklUser(userId, true);
    return true;
  },
};
