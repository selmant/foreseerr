import type { JellyfinLibraryItemExtended } from '@server/api/jellyfin';
import type {
  TvdbEpisodeCatalog,
  TvdbEpisodeCatalogItem,
} from '@server/api/tvdb/interfaces';
import { createUserJellyfinClient } from '@server/lib/library';
import logger from '@server/logger';

export const DEFAULT_WATCH_AHEAD_EPISODE_COUNT = 10;
export const MIN_WATCH_AHEAD_EPISODE_COUNT = 1;
export const MAX_WATCH_AHEAD_EPISODE_COUNT = 50;

export function watchAheadEpisodeCount(value: unknown): number {
  const parsed =
    typeof value === 'number' || typeof value === 'string'
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return DEFAULT_WATCH_AHEAD_EPISODE_COUNT;
  }
  return Math.min(
    MAX_WATCH_AHEAD_EPISODE_COUNT,
    Math.max(MIN_WATCH_AHEAD_EPISODE_COUNT, Math.round(parsed))
  );
}

export function optionalWatchAheadEpisodeCount(
  value: unknown
): number | undefined {
  if (value == null || value === '') {
    return undefined;
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return watchAheadEpisodeCount(parsed);
}

export type WatchAheadPlayedEpisode = {
  tvdbId?: number | string;
  seasonNumber?: number;
  episodeNumber?: number;
  played?: boolean;
};

export const regularCatalogEpisodes = (
  catalog: TvdbEpisodeCatalog
): TvdbEpisodeCatalogItem[] =>
  catalog.episodes.filter((episode) => episode.seasonNumber > 0);

export const playedTvdbIdsFromJellyfin = (
  catalog: TvdbEpisodeCatalog,
  items: WatchAheadPlayedEpisode[]
): Set<number> => {
  const knownTvdbIds = new Set(
    catalog.episodes.map((episode) => episode.tvdbId)
  );
  const bySeasonEpisode = new Map(
    regularCatalogEpisodes(catalog).map((episode) => [
      `${episode.seasonNumber}:${episode.episodeNumber}`,
      episode.tvdbId,
    ])
  );
  const played = new Set<number>();

  for (const item of items) {
    if (!item.played) {
      continue;
    }
    const rawTvdb =
      item.tvdbId != null && item.tvdbId !== ''
        ? Number(item.tvdbId)
        : Number.NaN;
    if (Number.isFinite(rawTvdb) && knownTvdbIds.has(rawTvdb)) {
      played.add(rawTvdb);
      continue;
    }
    if (item.seasonNumber != null && item.episodeNumber != null) {
      const mapped = bySeasonEpisode.get(
        `${item.seasonNumber}:${item.episodeNumber}`
      );
      if (mapped != null) {
        played.add(mapped);
      }
    }
  }

  return played;
};

export const resolveWatchAheadWindow = ({
  catalog,
  count,
  playedTvdbIds,
}: {
  catalog: TvdbEpisodeCatalog;
  count: number;
  playedTvdbIds?: ReadonlySet<number>;
}): {
  catalogEpisodes: TvdbEpisodeCatalogItem[];
  lastWatchedIndex: number;
  desired: TvdbEpisodeCatalogItem[];
} => {
  const catalogEpisodes = regularCatalogEpisodes(catalog);
  const played = playedTvdbIds ?? new Set<number>();
  let lastWatchedIndex = -1;
  for (let index = 0; index < catalogEpisodes.length; index += 1) {
    if (played.has(catalogEpisodes[index].tvdbId)) {
      lastWatchedIndex = index;
    }
  }
  const start = lastWatchedIndex + 1;
  return {
    catalogEpisodes,
    lastWatchedIndex,
    desired: catalogEpisodes.slice(
      start,
      start + watchAheadEpisodeCount(count)
    ),
  };
};

const jellyfinPlayedFields = (
  item: JellyfinLibraryItemExtended
): WatchAheadPlayedEpisode => ({
  tvdbId: item.ProviderIds?.Tvdb,
  seasonNumber: item.ParentIndexNumber,
  episodeNumber: item.IndexNumber,
  played: item.UserData?.Played === true,
});

export const loadPlayedTvdbIdsForSeries = async ({
  userId,
  jellyfinSeriesId,
  catalog,
}: {
  userId: number;
  jellyfinSeriesId?: string | null;
  catalog: TvdbEpisodeCatalog;
}): Promise<Set<number>> => {
  if (!jellyfinSeriesId) {
    return new Set();
  }

  try {
    const linked = await createUserJellyfinClient(userId);
    if (!linked.ok) {
      return new Set();
    }
    const items = await linked.client.getSeriesEpisodes(jellyfinSeriesId);
    return playedTvdbIdsFromJellyfin(catalog, items.map(jellyfinPlayedFields));
  } catch (error) {
    logger.warn('Failed to load Jellyfin watch progress for watch-ahead', {
      label: 'Watch Ahead',
      userId,
      jellyfinSeriesId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return new Set();
  }
};
