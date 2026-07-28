import type { EpisodeResult, SonarrSeries } from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import EpisodeRequest from '@server/entity/EpisodeRequest';
import { MediaRequest } from '@server/entity/MediaRequest';
import { getSettings } from '@server/lib/settings';
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
    const serviceId = request.is4k ? media.serviceId4k : media.serviceId;
    const externalId = request.is4k
      ? media.externalServiceId4k
      : media.externalServiceId;
    const server =
      settings.sonarr.find((item) => item.id === request.serverId) ??
      settings.sonarr.find((item) => item.id === serviceId) ??
      settings.sonarr.find(
        (item) => item.isDefault && item.is4k === request.is4k
      );

    if (!server || !externalId) {
      return undefined;
    }
    const key = `${server.id}:${externalId}`;
    const cached = cache.get(key);
    if (cached) {
      return cached;
    }

    const api = new SonarrAPI({
      apiKey: server.apiKey,
      url: SonarrAPI.buildUrl(server, '/api/v3'),
    });
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
      }
    }

    const unmonitored: number[] = [];
    const searchable: { child: EpisodeRequest; sonarrId: number }[] = [];
    const now = Date.now();

    for (const child of request.episodes) {
      const episode = byTvdbId.get(child.tvdbId);
      if (!episode) {
        continue;
      }
      if (episode.hasFile) {
        if (child.status !== MediaRequestStatus.COMPLETED) {
          child.status = MediaRequestStatus.COMPLETED;
          await episodeRepository.save(child);
        }
        continue;
      }
      if (!episode.monitored) {
        unmonitored.push(episode.id);
      }
      if (
        !context.preventSearch &&
        !child.searchTriggeredAt &&
        (!episode.airDateUtc || new Date(episode.airDateUtc).getTime() <= now)
      ) {
        searchable.push({ child, sonarrId: episode.id });
      }
    }

    await context.api.monitorEpisodes(unmonitored);
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
      request.episodeSelectionType !== 'after' ||
      context.series.status.toLowerCase() === 'ended';
    if (complete && mayComplete) {
      request.status = MediaRequestStatus.COMPLETED;
      await requestRepository.save(request);
    }
  }
}

const episodeRequestSync = new EpisodeRequestSync();
export default episodeRequestSync;
