import TheMovieDb from '@server/api/themoviedb';
import type { createAnilistUserClient } from '@server/lib/anilist';
import anilistIdMapping, {
  fribbSeasonCandidates,
  pickFribbSeasonEntry,
} from '@server/lib/anilist/mapping';
import { getAnilistUserContext } from '@server/lib/anilist/userContext';
import { ensureMappingLayer } from '@server/lib/mapping/bootstrap';
import {
  findEpisodeRules,
  translateEpisodeBridged,
} from '@server/lib/mapping/episodes';
import { AnilistMediaActionProvider } from './anilist';
import {
  absoluteEpisodeNumber,
  anilistProgressForEpisode,
  nextAnilistProgress,
  watchedEpisodeNumbersForSeason,
  watchedEpisodesFromProgress,
  type TmdbSeasonCount,
} from './anilistEpisodeProgress';
import {
  lookupAnilistEntryByAnilistId,
  patchUserAnilistSyncItem,
  warmUserAnilistSyncCache,
  type AnilistSyncEntry,
} from './anilistSyncCache';

const anilistProvider = new AnilistMediaActionProvider();

async function seasonEntries(tmdbShowId: number) {
  await anilistIdMapping.sync();
  return anilistIdMapping.getAnilistSeasonEntries('tv', tmdbShowId);
}

async function getClientContext(userId: number) {
  return getAnilistUserContext(userId);
}

function seasonsFromTmdb(show: {
  seasons?: { season_number: number; episode_count: number }[];
}): TmdbSeasonCount[] {
  return (show.seasons ?? []).map((season) => ({
    seasonNumber: season.season_number,
    episodeCount: season.episode_count,
  }));
}

function catalogOffset(
  mapping: {
    offsetTmdb: number;
    offsetTvdb: number;
  },
  catalog: 'tmdb' | 'tvdb'
): number {
  return catalog === 'tvdb' ? mapping.offsetTvdb : mapping.offsetTmdb;
}

/**
 * The exact AniList entry and progress for one TMDB episode, from stored episode
 * rules.
 *
 * Packs express their ranges against AniDB, so an AniList answer is bridged
 * through it. Returns undefined when no rule covers the episode, which is the
 * signal to fall back to season-level inference rather than to guess a number.
 */
async function progressFromRules(
  tmdbShowId: number,
  seasonNumber: number,
  episodeNumber: number
): Promise<{ anilistId: number; progress: number } | undefined> {
  await ensureMappingLayer();
  const from = {
    ns: 'tmdb_show' as const,
    id: String(tmdbShowId),
    season: seasonNumber,
    episode: episodeNumber,
  };
  const translated = await translateEpisodeBridged(from, 'anilist', [
    'anidb',
    'mal',
  ]);
  const anilistId = Number(translated?.target.id);
  if (!translated || !(anilistId > 0) || translated.episode < 1) {
    return undefined;
  }
  return { anilistId, progress: translated.episode };
}

/** Whether any rule at all covers this show, i.e. whether the engine applies. */
async function hasEpisodeRules(
  tmdbShowId: number,
  seasonNumber: number
): Promise<boolean> {
  const from = {
    ns: 'tmdb_show' as const,
    id: String(tmdbShowId),
    season: seasonNumber,
  };
  for (const namespace of ['anilist', 'anidb', 'mal'] as const) {
    if ((await findEpisodeRules(from, namespace)).length) return true;
  }
  return false;
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
      const entries = await seasonEntries(tmdbShowId);
      const candidates = fribbSeasonCandidates(entries, seasonNumber);
      if (candidates.entries.length === 0) {
        return { available: false, watchedEpisodeNumbers: [] };
      }
      const { client, anilistUserId } = await getClientContext(userId);
      const snapshot = await warmUserAnilistSyncCache(
        client,
        userId,
        anilistUserId
      );

      // Rules give an exact per-episode answer, so where they exist the season
      // heuristics below are not consulted at all.
      if (await hasEpisodeRules(tmdbShowId, seasonNumber)) {
        const show = await new TheMovieDb().getTvShow({ tvId: tmdbShowId });
        const season = seasonsFromTmdb(show).find(
          (item) => item.seasonNumber === seasonNumber
        );
        const watched: number[] = [];
        for (
          let episode = 1;
          episode <= (season?.episodeCount ?? 0);
          episode += 1
        ) {
          const mapped = await progressFromRules(
            tmdbShowId,
            seasonNumber,
            episode
          );
          if (!mapped) continue;
          const entry = lookupAnilistEntryByAnilistId(
            snapshot,
            mapped.anilistId
          );
          if ((entry?.progress ?? 0) >= mapped.progress) watched.push(episode);
        }
        return { available: true, watchedEpisodeNumbers: watched };
      }

      if (candidates.mode === 'absolute') {
        const mapping = candidates.entries[0];
        const entry = lookupAnilistEntryByAnilistId(
          snapshot,
          mapping.anilistId
        );
        const progress = entry?.progress ?? 0;
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
            entry?.episodeCount
          ),
        };
      }

      const show = await new TheMovieDb().getTvShow({ tvId: tmdbShowId });
      const season = seasonsFromTmdb(show).find(
        (item) => item.seasonNumber === seasonNumber
      );
      const watched = new Set<number>();
      for (const mapping of candidates.entries) {
        const entry = lookupAnilistEntryByAnilistId(
          snapshot,
          mapping.anilistId
        );
        const progress = entry?.progress ?? 0;
        if (progress <= 0) {
          continue;
        }
        for (const episode of watchedEpisodesFromProgress(
          progress,
          season?.episodeCount ?? progress,
          catalogOffset(mapping, candidates.catalog)
        )) {
          watched.add(episode);
        }
      }
      return {
        available: true,
        watchedEpisodeNumbers: [...watched].sort((left, right) => left - right),
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
    if (seasonNumber < 1 || episodeNumber < 1) {
      return 'skipped';
    }

    const fromRules = await progressFromRules(
      tmdbShowId,
      seasonNumber,
      episodeNumber
    );
    const entries = await seasonEntries(tmdbShowId);
    const picked = fromRules
      ? {
          mapping: { anilistId: fromRules.anilistId },
          progress: fromRules.progress,
          mode: 'in-season' as const,
        }
      : pickFribbSeasonEntry(entries, seasonNumber, episodeNumber);
    if (!picked) {
      return 'skipped';
    }

    const { client, anilistUserId } = await getClientContext(userId);
    const snapshot = await warmUserAnilistSyncCache(
      client,
      userId,
      anilistUserId
    );
    const current = lookupAnilistEntryByAnilistId(
      snapshot,
      picked.mapping.anilistId
    );
    let episodeCount = current?.episodeCount ?? null;
    if (episodeCount == null) {
      const media = await client.getMedia(picked.mapping.anilistId);
      episodeCount = media?.episodes ?? null;
    }

    let target = picked.progress;
    if (picked.mode === 'absolute') {
      const show = await new TheMovieDb().getTvShow({ tvId: tmdbShowId });
      const absolute = absoluteEpisodeNumber(
        seasonsFromTmdb(show),
        seasonNumber,
        episodeNumber
      );
      if (absolute == null) {
        return 'skipped';
      }
      const mapped = anilistProgressForEpisode(
        absolute,
        episodeCount,
        episodeNumber
      );
      if (mapped == null) {
        return 'skipped';
      }
      target = mapped;
    } else if (
      episodeCount != null &&
      episodeCount > 0 &&
      target > episodeCount
    ) {
      return 'skipped';
    }

    return writeProgress({
      client,
      userId,
      tmdbShowId,
      anilistId: picked.mapping.anilistId,
      current,
      episodeCount,
      target,
      watched,
    });
  },
};

async function writeProgress(options: {
  client: Awaited<ReturnType<typeof createAnilistUserClient>>;
  userId: number;
  tmdbShowId: number;
  anilistId: number;
  current: AnilistSyncEntry | null;
  episodeCount: number | null;
  target: number;
  watched: boolean;
}): Promise<boolean | 'skipped'> {
  const currentProgress = options.current?.progress ?? 0;
  const next = nextAnilistProgress(
    currentProgress,
    options.target,
    options.watched
  );
  if (next == null) {
    return options.watched ? true : 'skipped';
  }
  if (next <= 0 && !options.current?.listEntryId) {
    return 'skipped';
  }

  const completed =
    options.episodeCount != null &&
    options.episodeCount > 0 &&
    next >= options.episodeCount;
  const status = next <= 0 ? 'PLANNING' : completed ? 'COMPLETED' : 'CURRENT';
  const saved = await options.client.saveMediaListEntry({
    mediaId: options.anilistId,
    status,
    progress: Math.max(0, next),
  });

  patchUserAnilistSyncItem(options.userId, 'tv', options.tmdbShowId, {
    watched: completed,
    status,
    progress: Math.max(0, next),
    episodeCount: options.episodeCount,
    anilistId: options.anilistId,
    listEntryId: saved?.id ?? options.current?.listEntryId ?? null,
  });
  return true;
}
