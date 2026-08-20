import Tvdb from '@server/api/tvdb';
import type {
  TvdbEpisodeCatalog,
  TvdbEpisodeCatalogItem,
} from '@server/api/tvdb/interfaces';
import type { EpisodeSelection } from '@server/interfaces/api/requestInterfaces';
import {
  isAnimeMedia,
  type AnimeDetectionInput,
} from '@server/lib/anime/detect';
import { MetadataProviderType, type AllSettings } from '@server/lib/settings';
import { z } from 'zod';

const episodeId = z.number().int().positive().max(2_147_483_647);

export const episodeSelectionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('single'), episodeTvdbId: episodeId }).strict(),
  z
    .object({
      type: z.literal('range'),
      startEpisodeTvdbId: episodeId,
      endEpisodeTvdbId: episodeId,
    })
    .strict(),
  z
    .object({ type: z.literal('after'), startEpisodeTvdbId: episodeId })
    .strict(),
]);

export interface ResolvedEpisodeSelection {
  type: EpisodeSelection['type'];
  startTvdbId: number;
  endTvdbId?: number;
  episodes: TvdbEpisodeCatalogItem[];
  quotaUnits: number;
}

/**
 * Episode requests rely on the TVDB catalog. Anime titles can be configured
 * with a distinct metadata provider, so their provider selection must be
 * evaluated using the same detection as the request-creation flow.
 */
export const episodeRequestsAvailable = (
  settings: Pick<AllSettings, 'main' | 'metadataSettings'>,
  media: AnimeDetectionInput
): boolean =>
  settings.main.partialRequestsEnabled &&
  (isAnimeMedia(media)
    ? settings.metadataSettings.anime
    : settings.metadataSettings.tv) === MetadataProviderType.TVDB;

export const parseEpisodeSelection = (input: unknown): EpisodeSelection =>
  episodeSelectionSchema.parse(input);

export const resolveEpisodeSelection = (
  selection: EpisodeSelection,
  catalog: TvdbEpisodeCatalog,
  allowSpecials: boolean
): ResolvedEpisodeSelection => {
  const byId = new Map(
    catalog.episodes.map((episode, index) => [
      episode.tvdbId,
      { episode, index },
    ])
  );
  const startId =
    selection.type === 'single'
      ? selection.episodeTvdbId
      : selection.startEpisodeTvdbId;
  const start = byId.get(startId);

  if (!start) {
    throw new Error('The selected TVDB episode does not exist.');
  }
  if (start.episode.seasonNumber === 0 && !allowSpecials) {
    throw new Error('Special episode requests are disabled.');
  }

  let episodes: TvdbEpisodeCatalogItem[];
  let endTvdbId: number | undefined;

  if (selection.type === 'single') {
    episodes = [start.episode];
  } else {
    if (start.episode.seasonNumber === 0) {
      throw new Error(
        'Ranges and ongoing requests cannot start with a special.'
      );
    }

    if (selection.type === 'range') {
      const end = byId.get(selection.endEpisodeTvdbId);
      if (!end) {
        throw new Error('The selected TVDB range endpoint does not exist.');
      }
      if (end.episode.seasonNumber === 0 || end.index < start.index) {
        throw new Error('Episode range endpoints are invalid or reversed.');
      }
      endTvdbId = end.episode.tvdbId;
      episodes = catalog.episodes
        .slice(start.index, end.index + 1)
        .filter((episode) => episode.seasonNumber > 0);
    } else {
      episodes = catalog.episodes
        .slice(start.index)
        .filter((episode) => episode.seasonNumber > 0);
    }
  }

  if (episodes.length === 0) {
    throw new Error('No episodes are available for this selection.');
  }

  return {
    type: selection.type,
    startTvdbId: start.episode.tvdbId,
    endTvdbId,
    episodes,
    quotaUnits: new Set(episodes.map((episode) => episode.seasonNumber)).size,
  };
};

const ongoingEpisodeRequestLocks = new Map<string, Promise<unknown>>();

export const ongoingEpisodeRequestLockKey = (
  tmdbId: number,
  is4k: boolean
): string => `${tmdbId}:${is4k ? '4k' : 'sd'}`;

/**
 * Serialize concurrent "after"/ongoing episode creates for one series+quality.
 * Re-check the duplicate inside the lock; this is single-process only.
 */
export async function withOngoingEpisodeRequestLock<T>(
  tmdbId: number,
  is4k: boolean,
  task: () => Promise<T>
): Promise<T> {
  const key = ongoingEpisodeRequestLockKey(tmdbId, is4k);
  const previous = ongoingEpisodeRequestLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(
    () => held,
    () => held
  );
  ongoingEpisodeRequestLocks.set(key, queued);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (ongoingEpisodeRequestLocks.get(key) === queued) {
      ongoingEpisodeRequestLocks.delete(key);
    }
  }
}

export const getResolvedTvdbEpisodeSelection = async ({
  tvId,
  language,
  selection,
  allowSpecials,
}: {
  tvId: number;
  language?: string;
  selection: EpisodeSelection;
  allowSpecials: boolean;
}): Promise<ResolvedEpisodeSelection> => {
  const tvdb = await Tvdb.getInstance();
  const catalog = await tvdb.getEpisodeCatalog({ tvId, language });
  return resolveEpisodeSelection(selection, catalog, allowSpecials);
};
