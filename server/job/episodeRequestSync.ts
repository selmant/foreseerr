import type { EpisodeResult, SonarrSeries } from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import Tvdb from '@server/api/tvdb';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import EpisodeRequest from '@server/entity/EpisodeRequest';
import { MediaRequest } from '@server/entity/MediaRequest';
import { isRollingEpisodeSelection } from '@server/lib/episodeRequests';
import { getSettings } from '@server/lib/settings';
import {
  loadPlayedTvdbIdsForSeries,
  resolveWatchAheadWindow,
  watchAheadEpisodeCount,
} from '@server/lib/watchAhead';
import logger from '@server/logger';
import { IsNull, Not } from 'typeorm';

class EpisodeRequestSync {
  public running = false;
  private cancelled = false;

  public cancel(): void {
    this.cancelled = true;
  }

  public async run(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.cancelled = false;

    try {
      const requests = await getRepository(MediaRequest).find({
        where: {
          type: MediaType.TV,
          status: MediaRequestStatus.APPROVED,
          episodeSelectionType: Not(IsNull()),
        },
      });
      const cache = new Map<
        string,
        {
          api: SonarrAPI;
          series: SonarrSeries;
          episodes: EpisodeResult[];
          preventSearch: boolean;
        }
      >();

      for (const request of requests) {
        if (this.cancelled) {
          break;
        }
        try {
          const context = await this.getSonarrContext(request, cache);
          if (!context) {
            continue;
          }
          await this.reconcileRequest(request, context);
        } catch (error) {
          logger.warn('Failed to synchronize episode request', {
            label: 'Episode Request Sync',
            requestId: request.id,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.running = false;
      this.cancelled = false;
    }
  }

  private async getSonarrContext(
    request: MediaRequest,
    cache: Map<
      string,
      {
        api: SonarrAPI;
        series: SonarrSeries;
        episodes: EpisodeResult[];
        preventSearch: boolean;
      }
    >
  ) {
    const settings = getSettings();
    const media = request.media;
    const mediaServiceId = request.is4k ? media.serviceId4k : media.serviceId;
    const mediaExternalId = request.is4k
      ? media.externalServiceId4k
      : media.externalServiceId;
    const server =
      settings.sonarr.find((item) => item.id === request.serverId) ??
      settings.sonarr.find((item) => item.id === mediaServiceId) ??
      settings.sonarr.find(
        (item) => item.isDefault && item.is4k === request.is4k
      );

    if (!server) {
      return undefined;
    }

    const api = new SonarrAPI({
      apiKey: server.apiKey,
      url: SonarrAPI.buildUrl(server, '/api/v3'),
    });
    let externalId = mediaExternalId;
    if (mediaServiceId !== server.id) {
      if (!media.tvdbId) {
        return undefined;
      }
      const series = (await api.getSeries()).find(
        (item) => item.tvdbId === media.tvdbId
      );
      if (!series) {
        return undefined;
      }
      externalId = series.id;
    }
    if (!externalId) {
      return undefined;
    }
    const key = `${server.id}:${externalId}`;
    const cached = cache.get(key);
    if (cached) {
      return cached;
    }

    const [series, episodes] = await Promise.all([
      api.getSeriesById(externalId),
      api.getEpisodes(externalId),
    ]);
    const context = {
      api,
      series,
      episodes,
      preventSearch: server.preventSearch,
    };
    cache.set(key, context);
    return context;
  }

  private async reconcileRequest(
    request: MediaRequest,
    context: {
      api: SonarrAPI;
      series: SonarrSeries;
      episodes: EpisodeResult[];
      preventSearch: boolean;
    }
  ): Promise<void> {
    const episodeRepository = getRepository(EpisodeRequest);
    const requestRepository = getRepository(MediaRequest);
    const byTvdbId = new Map(
      context.episodes.map((episode) => [episode.tvdbId, episode])
    );

    const additionTvdbIds = new Set<number>();
    let watchAheadCatalogReady = true;
    let watchAheadCaughtUp = false;
    let watchAheadWindow: Set<number> | undefined;
    if (request.episodeSelectionType === 'after') {
      const boundary = byTvdbId.get(request.episodeStartTvdbId ?? -1);
      if (!boundary) {
        throw new Error('Sonarr does not contain the ongoing request boundary');
      }
      const knownIds = new Set(
        request.episodes.map((episode) => episode.tvdbId)
      );
      const additions = context.episodes.filter(
        (episode) =>
          episode.seasonNumber > 0 &&
          (episode.seasonNumber > boundary.seasonNumber ||
            (episode.seasonNumber === boundary.seasonNumber &&
              episode.episodeNumber >= boundary.episodeNumber)) &&
          !knownIds.has(episode.tvdbId)
      );
      if (additions.length > 0) {
        const saved = await episodeRepository.save(
          additions.map(
            (episode) =>
              new EpisodeRequest({
                request,
                tvdbId: episode.tvdbId,
                seasonNumber: episode.seasonNumber,
                episodeNumber: episode.episodeNumber,
                title: episode.title,
                airDate: episode.airDate,
                status: episode.hasFile
                  ? MediaRequestStatus.COMPLETED
                  : MediaRequestStatus.APPROVED,
              })
          )
        );
        request.episodes.push(...saved);
        for (const episode of additions) {
          additionTvdbIds.add(episode.tvdbId);
        }
      }
    } else if (request.episodeSelectionType === 'watchAhead') {
      const result = await this.expandWatchAhead(
        request,
        context,
        additionTvdbIds
      );
      watchAheadCatalogReady = result.ready;
      watchAheadCaughtUp = result.caughtUp;
      watchAheadWindow = result.window;
    }

    const unmonitored: number[] = [];
    const newlyMonitored: EpisodeRequest[] = [];
    const searchable: { child: EpisodeRequest; sonarrId: number }[] = [];
    const removedFlagChanged: EpisodeRequest[] = [];
    const removedTvdbIds = new Set<number>();
    const now = Date.now();

    for (const child of request.episodes) {
      const episode = byTvdbId.get(child.tvdbId);
      if (!episode) {
        continue;
      }
      const isNewFutureEpisode = additionTvdbIds.has(child.tvdbId);
      // Watch-ahead children are monitored once. After that Sonarr's flag
      // wins: an episode someone else unmonitored, or a completed child
      // whose file was deleted on purpose, stays unmonitored. Only episodes
      // in the current window are monitored: older children are behind the
      // viewer and may have been cleaned up already.
      const awaitingMonitor =
        !!watchAheadWindow?.has(child.tvdbId) &&
        !episode.hasFile &&
        child.status !== MediaRequestStatus.COMPLETED &&
        !child.monitoredAt;
      if ((isNewFutureEpisode || awaitingMonitor) && !episode.monitored) {
        unmonitored.push(episode.id);
      }
      if (awaitingMonitor) {
        newlyMonitored.push(child);
      }
      if (watchAheadWindow) {
        // An episode in the window that Foreseerr already monitored (or that
        // was downloaded) and that is now unmonitored without a file was
        // removed by someone else. Show it instead of fetching it again.
        const removed =
          watchAheadWindow.has(child.tvdbId) &&
          !episode.hasFile &&
          !episode.monitored &&
          (child.status === MediaRequestStatus.COMPLETED ||
            !!child.monitoredAt);
        if (removed) {
          removedTvdbIds.add(child.tvdbId);
        }
        if (removed !== !!child.unmonitoredAt) {
          child.unmonitoredAt = removed ? new Date() : null;
          removedFlagChanged.push(child);
        }
      }
      if (episode.hasFile) {
        if (child.status !== MediaRequestStatus.COMPLETED) {
          child.status = MediaRequestStatus.COMPLETED;
          await episodeRepository.save(child);
        }
        continue;
      }
      // A completed child lost its file on purpose, so do not search for it
      // even when Sonarr still monitors it.
      if (
        (isNewFutureEpisode || episode.monitored || awaitingMonitor) &&
        child.status !== MediaRequestStatus.COMPLETED &&
        !context.preventSearch &&
        !child.searchTriggeredAt &&
        (!episode.airDateUtc || new Date(episode.airDateUtc).getTime() <= now)
      ) {
        searchable.push({ child, sonarrId: episode.id });
      }
    }

    if (removedFlagChanged.length > 0) {
      await episodeRepository.save(removedFlagChanged);
    }
    if (watchAheadWindow) {
      const inactive =
        watchAheadWindow.size > 0 &&
        [...watchAheadWindow].every((tvdbId) => removedTvdbIds.has(tvdbId));
      if (inactive !== !!request.watchAheadInactiveAt) {
        const watchAheadInactiveAt = inactive ? new Date() : null;
        // Update the column alone: saving the request would run the request
        // subscriber, which sends the request to Sonarr again.
        await requestRepository
          .createQueryBuilder()
          .update()
          .set({ watchAheadInactiveAt })
          .where('id = :id', { id: request.id })
          .callListeners(false)
          .execute();
        request.watchAheadInactiveAt = watchAheadInactiveAt;
      }
    }

    await context.api.monitorEpisodes(unmonitored);
    if (newlyMonitored.length > 0) {
      const monitoredAt = new Date();
      for (const child of newlyMonitored) {
        child.monitoredAt = monitoredAt;
      }
      await episodeRepository.save(newlyMonitored);
    }
    if (searchable.length > 0) {
      await context.api.searchEpisodes(searchable.map((item) => item.sonarrId));
      const searchedAt = new Date();
      for (const item of searchable) {
        item.child.searchTriggeredAt = searchedAt;
      }
      await episodeRepository.save(searchable.map((item) => item.child));
    }

    const complete = request.episodes.every(
      (episode) => episode.status === MediaRequestStatus.COMPLETED
    );
    const mayComplete =
      !isRollingEpisodeSelection(request.episodeSelectionType) ||
      (request.episodeSelectionType === 'after' &&
        context.series.status.toLowerCase() === 'ended') ||
      (request.episodeSelectionType === 'watchAhead' &&
        watchAheadCatalogReady &&
        watchAheadCaughtUp &&
        context.series.status.toLowerCase() === 'ended');
    if (complete && mayComplete) {
      request.status = MediaRequestStatus.COMPLETED;
      await requestRepository.save(request);
    }
  }

  private async expandWatchAhead(
    request: MediaRequest,
    context: {
      episodes: EpisodeResult[];
    },
    additionTvdbIds: Set<number>
  ): Promise<{ ready: boolean; caughtUp: boolean; window?: Set<number> }> {
    const media = request.media;
    if (!media.tmdbId) {
      return { ready: false, caughtUp: false };
    }

    let catalog;
    try {
      const tvdb = await Tvdb.getInstance();
      catalog = await tvdb.getEpisodeCatalog({ tvId: media.tmdbId });
    } catch (error) {
      logger.warn('Failed to load TVDB catalog for watch-ahead sync', {
        label: 'Episode Request Sync',
        requestId: request.id,
        tmdbId: media.tmdbId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return { ready: false, caughtUp: false };
    }

    const playedTvdbIds = await loadPlayedTvdbIdsForSeries({
      userId: request.requestedBy.id,
      jellyfinSeriesId: request.is4k
        ? media.jellyfinMediaId4k
        : media.jellyfinMediaId,
      catalog,
    });
    if (!playedTvdbIds) {
      return { ready: false, caughtUp: false };
    }
    const window = resolveWatchAheadWindow({
      catalog,
      count: watchAheadEpisodeCount(request.watchAheadCount),
      playedTvdbIds,
    });
    const knownIds = new Set(request.episodes.map((episode) => episode.tvdbId));
    const bySonarrTvdbId = new Map(
      context.episodes.map((episode) => [episode.tvdbId, episode])
    );
    const desiredTvdbIds = new Set(
      window.desired.map((episode) => episode.tvdbId)
    );
    // Downloaded window episodes are tracked too, as completed children, so a
    // file deleted before it was watched is not requested again later.
    const additions = window.desired.filter(
      (episode) => !knownIds.has(episode.tvdbId)
    );
    if (additions.length === 0) {
      return {
        ready: true,
        caughtUp: window.desired.length === 0,
        window: desiredTvdbIds,
      };
    }

    const episodeRepository = getRepository(EpisodeRequest);
    const saved = await episodeRepository.save(
      additions.map((episode) => {
        const sonarrEpisode = bySonarrTvdbId.get(episode.tvdbId);
        return new EpisodeRequest({
          request,
          tvdbId: episode.tvdbId,
          seasonNumber: episode.seasonNumber,
          episodeNumber: episode.episodeNumber,
          title: episode.title,
          airDate: episode.airDate ?? sonarrEpisode?.airDate,
          status: sonarrEpisode?.hasFile
            ? MediaRequestStatus.COMPLETED
            : MediaRequestStatus.APPROVED,
        });
      })
    );
    request.episodes.push(...saved);
    for (const episode of additions) {
      if (!bySonarrTvdbId.get(episode.tvdbId)?.hasFile) {
        additionTvdbIds.add(episode.tvdbId);
      }
    }
    return { ready: true, caughtUp: false, window: desiredTvdbIds };
  }
}

const episodeRequestSync = new EpisodeRequestSync();
export default episodeRequestSync;
