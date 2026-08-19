import TheMovieDb from '@server/api/themoviedb';
import {
  AnilistNotLinkedError,
  createAnilistUserClient,
  getUserAnilistSettings,
} from '@server/lib/anilist';
import anilistIdMapping from '@server/lib/anilist/mapping';
import { AnilistMediaActionProvider } from './anilist';
import {
  absoluteEpisodeNumber,
  anilistProgressForEpisode,
  nextAnilistProgress,
  watchedEpisodeNumbersForSeason,
  type TmdbSeasonCount,
} from './anilistEpisodeProgress';
import {
  lookupAnilistItemStatus,
  patchUserAnilistSyncItem,
  warmUserAnilistSyncCache,
} from './anilistSyncCache';

const anilistProvider = new AnilistMediaActionProvider();

async function resolveAnilistId(tmdbShowId: number): Promise<number | null> {
  await anilistIdMapping.sync();
  return anilistIdMapping.getAnilistId('tv', tmdbShowId) ?? null;
}

async function getClientContext(userId: number) {
  const client = await createAnilistUserClient(userId);
  const settings = await getUserAnilistSettings(userId);
  const anilistUserId = Number(settings?.anilistUserId);
  if (!Number.isFinite(anilistUserId) || anilistUserId <= 0) {
    throw new AnilistNotLinkedError();
  }
  return { client, anilistUserId };
}

function seasonsFromTmdb(show: {
  seasons?: { season_number: number; episode_count: number }[];
}): TmdbSeasonCount[] {
  return (show.seasons ?? []).map((season) => ({
    seasonNumber: season.season_number,
    episodeCount: season.episode_count,
  }));
}

export const anilistEpisodeActions = {
  isAvailable(userId: number): Promise<boolean> {
    return anilistProvider.isAvailable(userId);
  },

  async getSeasonStatus(
    userId: number,
    tmdbShowId: number,
    seasonNumber: number
  ): Promise<{ available: boolean; watchedEpisodeNumbers: number[] }> {
    if (!(await anilistProvider.isAvailable(userId))) {
      return { available: false, watchedEpisodeNumbers: [] };
    }
    try {
      const anilistId = await resolveAnilistId(tmdbShowId);
      if (!anilistId) {
        return { available: false, watchedEpisodeNumbers: [] };
      }
      const { client, anilistUserId } = await getClientContext(userId);
      const snapshot = await warmUserAnilistSyncCache(
        client,
        userId,
        anilistUserId
      );
      const current = lookupAnilistItemStatus(snapshot, 'tv', tmdbShowId);
      const progress = current.entry?.progress ?? 0;
      if (progress <= 0) {
        return { available: true, watchedEpisodeNumbers: [] };
      }
      const show = await new TheMovieDb().getTvShow({ tvId: tmdbShowId });
      return {
        available: true,
        watchedEpisodeNumbers: watchedEpisodeNumbersForSeason(
          seasonsFromTmdb(show),
          seasonNumber,
          progress,
          current.entry?.episodeCount
        ),
      };
    } catch {
      return { available: false, watchedEpisodeNumbers: [] };
    }
  },

  async setWatched(
    userId: number,
    tmdbShowId: number,
    seasonNumber: number,
    episodeNumber: number,
    watched: boolean
  ): Promise<boolean | 'skipped'> {
    if (!(await anilistProvider.isAvailable(userId))) {
      return 'skipped';
    }
    const anilistId = await resolveAnilistId(tmdbShowId);
    if (!anilistId) {
      return 'skipped';
    }

    const show = await new TheMovieDb().getTvShow({ tvId: tmdbShowId });
    const seasons = seasonsFromTmdb(show);
    const absolute = absoluteEpisodeNumber(
      seasons,
      seasonNumber,
      episodeNumber
    );
    if (absolute == null) {
      return 'skipped';
    }

    const { client, anilistUserId } = await getClientContext(userId);
    const snapshot = await warmUserAnilistSyncCache(
      client,
      userId,
      anilistUserId
    );
    const current = lookupAnilistItemStatus(snapshot, 'tv', tmdbShowId);
    let episodeCount = current.entry?.episodeCount ?? null;
    if (episodeCount == null) {
      const media = await client.getMedia(anilistId);
      episodeCount = media?.episodes ?? null;
    }
    const target = anilistProgressForEpisode(
      absolute,
      episodeCount,
      episodeNumber
    );
    if (target == null) {
      return 'skipped';
    }

    const currentProgress = current.entry?.progress ?? 0;
    const next = nextAnilistProgress(currentProgress, target, watched);
    if (next == null) {
      return watched ? true : 'skipped';
    }
    if (next <= 0 && !current.entry?.listEntryId) {
      return 'skipped';
    }

    const completed =
      episodeCount != null && episodeCount > 0 && next >= episodeCount;
    const status = next <= 0 ? 'PLANNING' : completed ? 'COMPLETED' : 'CURRENT';
    const saved = await client.saveMediaListEntry({
      mediaId: anilistId,
      status,
      progress: Math.max(0, next),
    });

    patchUserAnilistSyncItem(userId, 'tv', tmdbShowId, {
      watched: completed,
      status,
      progress: Math.max(0, next),
      episodeCount,
      anilistId,
      listEntryId: saved?.id ?? current.entry?.listEntryId ?? null,
    });
    return true;
  },
};
