import { getRepository } from '@server/datasource';
import { SimklSyncItem } from '@server/entity/SimklSyncItem';
import { ensureMappingLayer } from '@server/lib/mapping/datasets';
import {
  applyEpisodeRule,
  findEpisodeRules,
  translateEpisodeBridged,
} from '@server/lib/mapping/episodes';
import { createSimklUserClient } from '@server/lib/simkl';
import { syncSimklUser } from '@server/lib/simklSync';
import { In } from 'typeorm';
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

  const [tvdb, anidb] = await Promise.all([
    translateEpisodeBridged(from, 'tvdb_show', ['anidb']),
    translateEpisodeBridged(from, 'anidb'),
  ]);

  // Simkl matches on any of these, so its own id is not needed.
  const ids: SimklCoordinates['ids'] = { tmdb: tmdbId };
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

/**
 * Every watched episode Simkl reports for a show, in Simkl's own numbering,
 * from the synced library rather than a fresh download.
 */
export const cachedWatchedCoordinates = async (
  userId: number,
  tmdbId: number
): Promise<WatchedCoordinate[]> => {
  const items = await getRepository(SimklSyncItem).find({
    where: { user: { id: userId }, tmdbId, simklType: In(['show', 'anime']) },
  });
  return items.flatMap((item) => {
    let coordinates: unknown;
    try {
      coordinates = JSON.parse(item.watchedEpisodes ?? '[]');
    } catch {
      return [];
    }
    return (Array.isArray(coordinates) ? coordinates : []).flatMap(
      (pair: unknown) =>
        Array.isArray(pair) &&
        Number.isInteger(pair[0]) &&
        Number.isInteger(pair[1])
          ? [{ season: pair[0] as number, episode: pair[1] as number }]
          : []
    );
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
    // Activities first; the library delta carries each show's episodes.
    await syncSimklUser(userId);
    const coordinates = await cachedWatchedCoordinates(userId, tmdbId);
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
