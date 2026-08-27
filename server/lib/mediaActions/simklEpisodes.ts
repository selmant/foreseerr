import { createSimklUserClient } from '@server/lib/simkl';
import { syncSimklUser } from '@server/lib/simklSync';
import { SimklMediaActionProvider } from './simkl';

const provider = new SimklMediaActionProvider();

const watchedNumbers = (
  payload: Record<string, unknown>,
  tmdbId: number,
  seasonNumber: number
): number[] => {
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
  return (
    show?.seasons?.find((season) => Number(season.number) === seasonNumber)
      ?.episodes ?? []
  )
    .filter((episode) => episode.watched_at !== undefined)
    .map((episode) => Number(episode.number))
    .filter((number) => Number.isInteger(number) && number > 0);
};

export const simklEpisodeActions = {
  isAvailable: (userId: number) => provider.isAvailable(userId),
  async getSeasonStatus(userId: number, tmdbId: number, seasonNumber: number) {
    if (!(await provider.isAvailable(userId)))
      return { available: false, watchedEpisodeNumbers: [] };
    const client = await createSimklUserClient(userId);
    return {
      available: true,
      watchedEpisodeNumbers: watchedNumbers(
        await client.getWatchedEpisodes(),
        tmdbId,
        seasonNumber
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
    await (
      await createSimklUserClient(userId)
    ).setEpisodeHistory(tmdbId, seasonNumber, episodeNumber, watched);
    await syncSimklUser(userId, true);
    return true;
  },
};
