import type { TraktListEntry } from '@server/api/trakt/interfaces';
import { createTraktUserClient } from '@server/lib/trakt';
import { invalidateUserSyncCache, warmUserSyncCache } from './syncCache';
import { TraktMediaActionProvider } from './trakt';

export interface TraktEpisodeSeasonStatus {
  available: boolean;
  watchedEpisodeNumbers: number[];
}

export function findWatchedEpisodeNumbers(
  watchedShows: TraktListEntry[],
  tmdbId: number,
  seasonNumber: number
): number[] {
  const show = watchedShows.find(
    (entry) => Number(entry.show?.ids?.tmdb) === tmdbId
  );
  const season = show?.seasons?.find((entry) => entry.number === seasonNumber);
  return Array.from(
    new Set(
      (season?.episodes ?? [])
        .filter((episode) => (episode.plays ?? 1) > 0)
        .map((episode) => episode.number)
    )
  ).sort((a, b) => a - b);
}

const traktProvider = new TraktMediaActionProvider();

async function isAvailable(userId: number): Promise<boolean> {
  return traktProvider.isAvailable(userId);
}

export const traktEpisodeActions = {
  isAvailable,

  async getSeasonStatus(
    userId: number,
    tmdbId: number,
    seasonNumber: number
  ): Promise<TraktEpisodeSeasonStatus> {
    if (!(await isAvailable(userId))) {
      return { available: false, watchedEpisodeNumbers: [] };
    }
    const client = await createTraktUserClient(userId);
    const snapshot = await warmUserSyncCache(client, userId);
    return {
      available: true,
      watchedEpisodeNumbers: findWatchedEpisodeNumbers(
        snapshot.watchedShows,
        tmdbId,
        seasonNumber
      ),
    };
  },

  async setWatched(
    userId: number,
    tmdbShowId: number,
    seasonNumber: number,
    episodeNumber: number,
    watched: boolean
  ): Promise<boolean> {
    if (!(await isAvailable(userId))) {
      return false;
    }
    const client = await createTraktUserClient(userId);
    if (watched) {
      await client.addEpisodeToHistory(tmdbShowId, seasonNumber, episodeNumber);
    } else {
      await client.removeEpisodeFromHistory(
        tmdbShowId,
        seasonNumber,
        episodeNumber
      );
    }
    invalidateUserSyncCache(userId);
    return true;
  },
};
