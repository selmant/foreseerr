import type JellyfinAPI from '@server/api/jellyfin';
import type { JellyfinLibraryItemExtended } from '@server/api/jellyfin';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { mapWithConcurrency } from '@server/lib/concurrency';
import {
  invalidateJellyfinStatusCache,
  setCachedJellyfinWatched,
} from '@server/lib/mediaActions/jellyfinStatusCache';
import { traktEpisodeActions } from '@server/lib/mediaActions/traktEpisodes';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { Brackets } from 'typeorm';
import {
  episodeProgress,
  isStaleSkippedEpisode,
} from './skippedEpisodeEndings';

const SERIES_HYDRATION_CONCURRENCY = 4;
type SeasonStatus = { available: boolean; watchedEpisodeNumbers: number[] };

export interface SkippedEpisodeCleanupDependencies {
  providersAvailable(userId: number): Promise<boolean>;
  loadSeriesEpisodes(
    client: JellyfinAPI,
    seriesId: string
  ): Promise<JellyfinLibraryItemExtended[]>;
  loadMappedTmdbIds(seriesIds: string[]): Promise<Map<string, number>>;
  loadSeriesItem(
    client: JellyfinAPI,
    seriesId: string
  ): Promise<JellyfinLibraryItemExtended | undefined>;
  getTraktSeasonStatus(
    userId: number,
    tmdbId: number,
    seasonNumber: number
  ): Promise<SeasonStatus>;
  setTraktWatched(
    userId: number,
    tmdbId: number,
    seasonNumber: number,
    episodeNumber: number
  ): Promise<boolean>;
  markJellyfinPlayed(
    client: JellyfinAPI,
    userId: number,
    episodeId: string
  ): Promise<void>;
}

const providerTmdbId = (
  item: JellyfinLibraryItemExtended
): number | undefined => {
  const raw = item.ProviderIds?.Tmdb ?? item.ProviderIds?.TheMovieDb;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const defaultDependencies: SkippedEpisodeCleanupDependencies = {
  async providersAvailable(userId) {
    if (getSettings().mediaActions?.providers?.jellyfin === false) return false;
    return traktEpisodeActions.isAvailable(userId);
  },
  loadSeriesEpisodes: (client, seriesId) => client.getSeriesEpisodes(seriesId),
  loadSeriesItem: (client, seriesId) => client.getItemData(seriesId),
  async loadMappedTmdbIds(seriesIds) {
    if (!seriesIds.length) return new Map();
    const rows = await getRepository(Media)
      .createQueryBuilder('media')
      .where('media.mediaType = :mediaType', { mediaType: MediaType.TV })
      .andWhere(
        new Brackets((query) => {
          query
            .where('media.jellyfinMediaId IN (:...seriesIds)', { seriesIds })
            .orWhere('media.jellyfinMediaId4k IN (:...seriesIds)', {
              seriesIds,
            });
        })
      )
      .getMany();
    const result = new Map<string, number>();
    for (const row of rows) {
      if (!(Number.isFinite(row.tmdbId) && row.tmdbId > 0)) continue;
      if (row.jellyfinMediaId && seriesIds.includes(row.jellyfinMediaId)) {
        result.set(row.jellyfinMediaId, row.tmdbId);
      }
      if (row.jellyfinMediaId4k && seriesIds.includes(row.jellyfinMediaId4k)) {
        result.set(row.jellyfinMediaId4k, row.tmdbId);
      }
    }
    return result;
  },
  getTraktSeasonStatus: (userId, tmdbId, seasonNumber) =>
    traktEpisodeActions.getSeasonStatus(userId, tmdbId, seasonNumber),
  setTraktWatched: (userId, tmdbId, seasonNumber, episodeNumber) =>
    traktEpisodeActions.setWatched(
      userId,
      tmdbId,
      seasonNumber,
      episodeNumber,
      true
    ),
  async markJellyfinPlayed(client, userId, episodeId) {
    await client.markPlayed(episodeId);
    invalidateJellyfinStatusCache(userId);
    setCachedJellyfinWatched(userId, episodeId, true);
  },
};

export async function cleanupSkippedEpisodeEndings(
  userId: number,
  client: JellyfinAPI,
  resume: JellyfinLibraryItemExtended[],
  dependencies: SkippedEpisodeCleanupDependencies = defaultDependencies
): Promise<JellyfinLibraryItemExtended[]> {
  const preliminary = resume.filter(
    (item) => item.Type === 'Episode' && (episodeProgress(item) ?? -1) >= 50
  );
  const summary = {
    candidates: preliminary.length,
    completed: 0,
    skipped: 0,
    failed: 0,
  };
  if (!preliminary.length) {
    logger.info('Skipped episode cleanup pass', {
      label: 'Library',
      userId,
      ...summary,
    });
    return resume;
  }
  let providersAvailable = false;
  try {
    providersAvailable = await dependencies.providersAvailable(userId);
  } catch (error) {
    logger.warn('Skipped episode provider availability check failed', {
      label: 'Library',
      userId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
  if (!providersAvailable) {
    summary.skipped = preliminary.length;
    logger.info('Skipped episode cleanup pass', {
      label: 'Library',
      userId,
      ...summary,
      providers: 'unavailable',
    });
    return resume;
  }

  const preliminarySeriesIds = [
    ...new Set(
      preliminary
        .map((item) => item.SeriesId)
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const episodesBySeries = new Map<string, JellyfinLibraryItemExtended[]>();
  await mapWithConcurrency(
    preliminarySeriesIds,
    SERIES_HYDRATION_CONCURRENCY,
    async (seriesId) => {
      try {
        episodesBySeries.set(
          seriesId,
          await dependencies.loadSeriesEpisodes(client, seriesId)
        );
      } catch (error) {
        logger.warn('Skipped episode series hydration failed', {
          label: 'Library',
          userId,
          seriesId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  const classified = preliminary.filter(
    (item) =>
      item.SeriesId &&
      isStaleSkippedEpisode(item, episodesBySeries.get(item.SeriesId) ?? [])
  );
  summary.skipped += preliminary.length - classified.length;
  const classifiedSeriesIds = [
    ...new Set(classified.map((item) => item.SeriesId as string)),
  ];
  let tmdbBySeries = new Map<string, number>();
  try {
    tmdbBySeries = await dependencies.loadMappedTmdbIds(classifiedSeriesIds);
  } catch (error) {
    logger.warn('Skipped episode media mapping lookup failed', {
      label: 'Library',
      userId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
  await mapWithConcurrency(
    classifiedSeriesIds.filter((seriesId) => !tmdbBySeries.has(seriesId)),
    SERIES_HYDRATION_CONCURRENCY,
    async (seriesId) => {
      try {
        const series = await dependencies.loadSeriesItem(client, seriesId);
        const tmdbId = series ? providerTmdbId(series) : undefined;
        if (tmdbId) tmdbBySeries.set(seriesId, tmdbId);
      } catch (error) {
        logger.warn('Skipped episode series mapping failed', {
          label: 'Library',
          userId,
          seriesId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  const classifiedIds = new Set(classified.map((item) => item.Id));
  const completedIds = new Set<string>();
  const seasonStatus = new Map<string, Set<number>>();
  for (const item of resume) {
    if (!classifiedIds.has(item.Id)) continue;
    const seriesId = item.SeriesId as string;
    const showTmdbId = tmdbBySeries.get(seriesId);
    const season = item.ParentIndexNumber as number;
    const episode = item.IndexNumber as number;
    const context = {
      label: 'Library',
      userId,
      seriesId,
      episodeId: item.Id,
      season,
      episode,
      progress: episodeProgress(item),
    };
    if (!showTmdbId) {
      summary.skipped += 1;
      logger.warn('Skipped episode has no safe series TMDB mapping', context);
      continue;
    }
    const statusKey = `${showTmdbId}:${season}`;
    try {
      let watched = seasonStatus.get(statusKey);
      let traktState = 'already_watched';
      if (!watched) {
        const status = await dependencies.getTraktSeasonStatus(
          userId,
          showTmdbId,
          season
        );
        if (!status.available) {
          summary.skipped += 1;
          logger.warn('Skipped episode Trakt status unavailable', {
            ...context,
            trakt: 'unavailable',
            jellyfin: 'not_attempted',
          });
          continue;
        }
        watched = new Set(status.watchedEpisodeNumbers);
        seasonStatus.set(statusKey, watched);
      }
      if (!watched.has(episode)) {
        const updated = await dependencies.setTraktWatched(
          userId,
          showTmdbId,
          season,
          episode
        );
        if (!updated) throw new Error('Trakt episode action unavailable');
        watched.add(episode);
        traktState = 'updated';
      }
      try {
        await dependencies.markJellyfinPlayed(client, userId, item.Id);
      } catch (error) {
        summary.failed += 1;
        logger.warn('Skipped episode Jellyfin update failed', {
          ...context,
          trakt: traktState,
          jellyfin: 'failed',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      completedIds.add(item.Id);
      summary.completed += 1;
      logger.info('Skipped episode completed', {
        ...context,
        trakt: traktState,
        jellyfin: 'succeeded',
      });
    } catch (error) {
      summary.failed += 1;
      logger.warn('Skipped episode Trakt update failed', {
        ...context,
        trakt: 'failed',
        jellyfin: 'not_attempted',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }
  logger.info('Skipped episode cleanup pass', {
    label: 'Library',
    userId,
    ...summary,
  });
  return resume.filter((item) => !completedIds.has(item.Id));
}
