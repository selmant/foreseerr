import logger from '@server/logger';
import type { AxiosResponse } from 'axios';
import ServarrBase, { manualImportQuery, type QueueDetailsItem } from './base';
import type { ManualImportCandidate, ServarrRelease } from './radarr';

export interface SonarrSeason {
  seasonNumber: number;
  monitored: boolean;
  statistics?: {
    previousAiring?: string;
    episodeFileCount: number;
    episodeCount: number;
    totalEpisodeCount: number;
    sizeOnDisk: number;
    percentOfEpisodes: number;
  };
}
export interface EpisodeResult {
  seriesId: number;
  episodeFileId: number;
  seasonNumber: number;
  episodeNumber: number;
  tvdbId: number;
  title: string;
  airDate: string;
  airDateUtc: string;
  overview: string;
  hasFile: boolean;
  monitored: boolean;
  absoluteEpisodeNumber: number;
  unverifiedSceneNumbering: boolean;
  id: number;
}

/** The series fields Sonarr includes with calendar episode responses. */
export interface SonarrCalendarSeries {
  id: number;
  title: string;
  tvdbId: number;
  monitored: boolean;
  titleSlug?: string;
}

export interface SonarrCalendarEpisode extends EpisodeResult {
  series?: SonarrCalendarSeries;
}

export interface SonarrSeries {
  title: string;
  sortTitle: string;
  seasonCount: number;
  status: string;
  overview: string;
  network: string;
  airTime: string;
  images: {
    coverType: string;
    url: string;
  }[];
  remotePoster: string;
  seasons: SonarrSeason[];
  year: number;
  path: string;
  profileId: number;
  languageProfileId: number;
  seasonFolder: boolean;
  monitored: boolean;
  monitorNewItems: 'all' | 'none';
  useSceneNumbering: boolean;
  runtime: number;
  tvdbId: number;
  tvRageId: number;
  tvMazeId: number;
  firstAired: string;
  lastInfoSync?: string;
  seriesType: 'standard' | 'daily' | 'anime';
  cleanTitle: string;
  imdbId: string;
  titleSlug: string;
  certification: string;
  genres: string[];
  tags: number[];
  added: string;
  ratings: {
    votes: number;
    value: number;
  };
  qualityProfileId: number;
  id?: number;
  rootFolderPath?: string;
  addOptions?: {
    ignoreEpisodesWithFiles?: boolean;
    ignoreEpisodesWithoutFiles?: boolean;
    searchForMissingEpisodes?: boolean;
  };
  statistics: {
    seasonCount: number;
    episodeFileCount: number;
    episodeCount: number;
    totalEpisodeCount: number;
    sizeOnDisk: number;
    releaseGroups: string[];
    percentOfEpisodes: number;
  };
}

export interface AddSeriesOptions {
  tvdbid: number;
  title: string;
  profileId: number;
  languageProfileId?: number;
  seasons: number[];
  seasonFolder: boolean;
  rootFolderPath: string;
  tags?: number[];
  seriesType: SonarrSeries['seriesType'];
  monitored?: boolean;
  monitorNewItems?: SonarrSeries['monitorNewItems'];
  searchNow?: boolean;
  episodeTvdbIds?: number[];
}

interface EpisodeSelectionRetryOptions {
  attempts?: number;
  delayMs?: number;
  waitForAddOptions?: boolean;
}

const NEW_SERIES_EPISODE_ATTEMPTS = 30;
const NEW_SERIES_EPISODE_RETRY_DELAY_MS = 500;

const delay = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export interface LanguageProfile {
  id: number;
  name: string;
}

class SonarrAPI extends ServarrBase<{
  seriesId: number;
  episodeId: number;
  episode: EpisodeResult;
}> {
  constructor({ url, apiKey }: { url: string; apiKey: string }) {
    super({ url, apiKey, apiName: 'Sonarr', cacheName: 'sonarr' });
  }

  public async getSeries(): Promise<SonarrSeries[]> {
    try {
      const response = await this.axios.get<SonarrSeries[]>('/series');

      return response.data;
    } catch (e) {
      throw new Error(`[Sonarr] Failed to retrieve series: ${e.message}`, {
        cause: e,
      });
    }
  }

  public async getSeriesById(id: number): Promise<SonarrSeries> {
    try {
      const response = await this.axios.get<SonarrSeries>(`/series/${id}`);

      return response.data;
    } catch (e) {
      throw new Error(
        `[Sonarr] Failed to retrieve series by ID: ${e.message}`,
        { cause: e }
      );
    }
  }

  public async getSeriesByTitle(title: string): Promise<SonarrSeries[]> {
    try {
      const response = await this.axios.get<SonarrSeries[]>('/series/lookup', {
        params: {
          term: title,
        },
      });

      if (!response.data[0]) {
        throw new Error('No series found');
      }

      return response.data;
    } catch (e) {
      logger.error('Error retrieving series by series title', {
        label: 'Sonarr API',
        errorMessage: e.message,
        title,
      });
      throw new Error('No series found', { cause: e });
    }
  }

  public async getSeriesByTvdbId(id: number): Promise<SonarrSeries> {
    let response: AxiosResponse<SonarrSeries[]>;
    try {
      response = await this.axios.get<SonarrSeries[]>('/series/lookup', {
        params: {
          term: `tvdb:${id}`,
        },
      });
    } catch (e) {
      logger.error('Error retrieving series by tvdb ID', {
        label: 'Sonarr API',
        errorMessage: e.message,
        tvdbId: id,
      });
      throw e;
    }

    if (!response.data[0]) {
      throw new Error('Series not found');
    }

    return response.data[0];
  }

  public async addSeries(options: AddSeriesOptions): Promise<SonarrSeries> {
    try {
      const series = await this.getSeriesByTvdbId(options.tvdbid);

      if (series.id) {
        const existing = await this.getSeriesById(series.id);

        const newSeriesResponse = await this.axios.put<SonarrSeries>(
          '/series',
          {
            ...existing,
            monitored: options.monitored ?? existing.monitored,
            tags: options.tags
              ? Array.from(new Set([...existing.tags, ...options.tags]))
              : existing.tags,
            seasons: this.buildSeasonList(options.seasons, existing.seasons),
            addOptions: undefined,
          }
        );

        if (newSeriesResponse.data.id) {
          logger.info('Updated existing series in Sonarr.', {
            label: 'Sonarr',
            seriesId: newSeriesResponse.data.id,
            seriesTitle: newSeriesResponse.data.title,
          });
          logger.debug('Sonarr update details', {
            label: 'Sonarr',
            series: newSeriesResponse.data,
          });

          if (options.episodeTvdbIds?.length) {
            await this.applyEpisodeSelection(
              newSeriesResponse.data.id,
              options.episodeTvdbIds,
              options.searchNow ?? false
            );
          } else {
            try {
              const episodes = await this.getEpisodes(
                newSeriesResponse.data.id
              );
              const episodeIdsToMonitor = episodes
                .filter(
                  (ep) =>
                    options.seasons.includes(ep.seasonNumber) && !ep.monitored
                )
                .map((ep) => ep.id);

              if (episodeIdsToMonitor.length > 0) {
                logger.debug(
                  'Re-monitoring unmonitored episodes for requested seasons.',
                  {
                    label: 'Sonarr',
                    seriesId: newSeriesResponse.data.id,
                    episodeCount: episodeIdsToMonitor.length,
                  }
                );
                await this.monitorEpisodes(episodeIdsToMonitor);
              }
            } catch (e) {
              logger.warn('Failed to re-monitor episodes', {
                label: 'Sonarr',
                errorMessage: e.message,
                seriesId: newSeriesResponse.data.id,
              });
            }

            if (options.searchNow) {
              this.searchSeries(newSeriesResponse.data.id);
            }
          }

          return newSeriesResponse.data;
        } else {
          logger.error('Failed to update series in Sonarr', {
            label: 'Sonarr',
            options,
          });
          throw new Error('Failed to update series in Sonarr');
        }
      }

      const createdSeriesResponse = await this.axios.post<SonarrSeries>(
        '/series',
        {
          tvdbId: options.tvdbid,
          title: options.title,
          qualityProfileId: options.profileId,
          languageProfileId: options.languageProfileId,
          seasons: this.buildSeasonList(
            options.seasons,
            series.seasons.map((season) => ({
              seasonNumber: season.seasonNumber,
              // We force all seasons to false if its the first request
              monitored: false,
            }))
          ),
          tags: options.tags,
          seasonFolder: options.seasonFolder,
          monitored: options.monitored,
          monitorNewItems: options.monitorNewItems,
          rootFolderPath: options.rootFolderPath,
          seriesType: options.seriesType,
          addOptions: {
            ignoreEpisodesWithFiles: true,
            searchForMissingEpisodes:
              options.episodeTvdbIds?.length === 0 ||
              options.episodeTvdbIds === undefined
                ? options.searchNow
                : false,
          },
        } as Partial<SonarrSeries>
      );

      if (createdSeriesResponse.data.id) {
        logger.info('Sonarr accepted request', { label: 'Sonarr' });
        logger.debug('Sonarr add details', {
          label: 'Sonarr',
          series: createdSeriesResponse.data,
        });
      } else {
        logger.error('Failed to add series to Sonarr', {
          label: 'Sonarr',
          options,
        });
        throw new Error('Failed to add series to Sonarr');
      }

      if (createdSeriesResponse.data.id && options.episodeTvdbIds?.length) {
        await this.applyEpisodeSelection(
          createdSeriesResponse.data.id,
          options.episodeTvdbIds,
          options.searchNow ?? false,
          {
            attempts: NEW_SERIES_EPISODE_ATTEMPTS,
            delayMs: NEW_SERIES_EPISODE_RETRY_DELAY_MS,
            waitForAddOptions: true,
          }
        );
      }

      return createdSeriesResponse.data;
    } catch (e) {
      logger.error('Something went wrong while adding a series to Sonarr.', {
        label: 'Sonarr API',
        errorMessage: e.message,
        options,
        response: e?.response?.data,
      });
      throw new Error('Failed to add series', { cause: e });
    }
  }

  public async getLanguageProfiles(): Promise<LanguageProfile[]> {
    try {
      const data = await this.getRolling<LanguageProfile[]>(
        '/languageprofile',
        undefined,
        3600
      );

      return data;
    } catch (e) {
      logger.error(
        'Something went wrong while retrieving Sonarr language profiles.',
        {
          label: 'Sonarr API',
          errorMessage: e.message,
        }
      );

      throw new Error('Failed to get language profiles', { cause: e });
    }
  }

  public async searchSeries(seriesId: number): Promise<void> {
    logger.info('Executing series search command.', {
      label: 'Sonarr API',
      seriesId,
    });

    try {
      await this.runCommand('MissingEpisodeSearch', { seriesId });
    } catch (e) {
      logger.error(
        'Something went wrong while executing Sonarr missing episode search.',
        {
          label: 'Sonarr API',
          errorMessage: e.message,
          seriesId,
        }
      );
    }
  }

  public async getEpisodes(seriesId: number): Promise<EpisodeResult[]> {
    try {
      const response = await this.axios.get<EpisodeResult[]>('/episode', {
        params: { seriesId },
      });
      return response.data;
    } catch (e) {
      logger.error('Failed to retrieve episodes', {
        label: 'Sonarr API',
        errorMessage: e.message,
        seriesId,
      });
      throw new Error('Failed to get episodes', { cause: e });
    }
  }

  public async getCalendar(
    start: Date | string,
    end: Date | string,
    includeUnmonitored = false
  ): Promise<SonarrCalendarEpisode[]> {
    try {
      const response = await this.axios.get<SonarrCalendarEpisode[]>(
        '/calendar',
        {
          params: {
            start: start instanceof Date ? start.toISOString() : start,
            end: end instanceof Date ? end.toISOString() : end,
            unmonitored: includeUnmonitored,
          },
        }
      );

      const episodes = response.data;
      const seriesIds = [
        ...new Set(
          episodes
            .filter((episode) => !episode.series)
            .map((episode) => episode.seriesId)
        ),
      ];

      if (seriesIds.length === 0) {
        return episodes;
      }

      // Some Sonarr versions omit the embedded series object from calendar
      // responses. Fetch each missing series once, then apply it to all of
      // that series' episodes instead of making one request per episode.
      const seriesById = new Map<number, SonarrCalendarSeries>();
      await Promise.all(
        seriesIds.map(async (seriesId) => {
          try {
            const series = await this.getSeriesById(seriesId);
            seriesById.set(seriesId, {
              id: series.id ?? seriesId,
              title: series.title,
              tvdbId: series.tvdbId,
              monitored: series.monitored,
              titleSlug: series.titleSlug,
            });
          } catch (e) {
            logger.warn('Failed to enrich Sonarr calendar episode series', {
              label: 'Sonarr API',
              errorMessage: e instanceof Error ? e.message : String(e),
              seriesId,
            });
          }
        })
      );

      return episodes.map((episode) =>
        episode.series || !seriesById.has(episode.seriesId)
          ? episode
          : { ...episode, series: seriesById.get(episode.seriesId) }
      );
    } catch (e) {
      throw new Error(`[Sonarr] Failed to retrieve calendar: ${e.message}`, {
        cause: e,
      });
    }
  }

  public async monitorEpisodes(episodeIds: number[]): Promise<void> {
    if (episodeIds.length === 0) {
      return;
    }
    try {
      await this.axios.put('/episode/monitor', {
        episodeIds,
        monitored: true,
      });
    } catch (e) {
      logger.error('Failed to monitor episodes', {
        label: 'Sonarr API',
        errorMessage: e.message,
        episodeIds,
      });
      throw new Error('Failed to monitor episodes', { cause: e });
    }
  }

  public async searchEpisodes(episodeIds: number[]): Promise<void> {
    if (episodeIds.length === 0) {
      return;
    }
    await this.runCommand('EpisodeSearch', { episodeIds });
  }

  public async getEpisodeReleases(
    episodeId: number
  ): Promise<ServarrRelease[]> {
    const response = await this.axios.get<ServarrRelease[]>('/release', {
      params: { episodeId },
    });
    return response.data;
  }

  public async getSeasonReleases(
    seriesId: number,
    seasonNumber: number
  ): Promise<ServarrRelease[]> {
    const response = await this.axios.get<ServarrRelease[]>('/release', {
      params: { seriesId, seasonNumber },
    });
    return response.data;
  }

  public async getSeriesQueueDetails(
    seriesId: number
  ): Promise<QueueDetailsItem[]> {
    const response = await this.axios.get<QueueDetailsItem[]>(
      '/queue/details',
      {
        params: { seriesId },
      }
    );
    return response.data;
  }

  public async getSeriesQueue(seriesId: number) {
    return (await this.getQueue()).filter((item) => item.seriesId === seriesId);
  }

  public async getManualImportCandidates(params: {
    seriesId?: number;
    folder?: string;
    downloadId?: string;
  }): Promise<ManualImportCandidate[]> {
    const response = await this.axios.get<ManualImportCandidate[]>(
      '/manualimport',
      {
        params: manualImportQuery(params),
      }
    );
    return response.data;
  }

  public async reprocessManualImportCandidates(
    files: ManualImportCandidate[]
  ): Promise<ManualImportCandidate[]> {
    const response = await this.axios.post<ManualImportCandidate[]>(
      '/manualimport',
      files
    );
    return response.data;
  }

  public async manualImport(
    files: ManualImportCandidate[],
    importMode: 'move' | 'copy'
  ) {
    return this.runCommand('ManualImport', { files, importMode });
  }

  public async applyEpisodeSelection(
    seriesId: number,
    tvdbEpisodeIds: number[],
    searchNow: boolean,
    retryOptions: EpisodeSelectionRetryOptions = {}
  ): Promise<EpisodeResult[]> {
    const wanted = new Set(tvdbEpisodeIds);
    const attempts = Math.max(1, retryOptions.attempts ?? 1);
    const delayMs = Math.max(0, retryOptions.delayMs ?? 0);
    let episodes: EpisodeResult[] = [];
    let unresolved = tvdbEpisodeIds;

    if (retryOptions.waitForAddOptions) {
      await this.waitForConsumedAddOptions(seriesId, retryOptions);
    }

    for (let attempt = 1; attempt <= attempts; attempt++) {
      episodes = (await this.getEpisodes(seriesId)).filter((episode) =>
        wanted.has(episode.tvdbId)
      );
      const resolved = new Set(episodes.map((episode) => episode.tvdbId));
      unresolved = tvdbEpisodeIds.filter((id) => !resolved.has(id));

      if (unresolved.length === 0 || attempt === attempts) {
        break;
      }

      logger.debug('Waiting for Sonarr to populate newly added episodes.', {
        label: 'Sonarr',
        seriesId,
        attempt,
        attempts,
        unresolvedEpisodeCount: unresolved.length,
      });
      await delay(delayMs);
    }

    if (unresolved.length > 0) {
      throw new Error(
        `[Sonarr] Failed to resolve TVDB episode IDs: ${unresolved.join(', ')}`
      );
    }

    const missing = episodes.filter((episode) => !episode.hasFile);
    const unmonitored = missing
      .filter((episode) => !episode.monitored)
      .map((episode) => episode.id);
    if (unmonitored.length > 0) {
      await this.monitorEpisodes(unmonitored);
    }

    if (searchNow) {
      const now = Date.now();
      const airedMissing = missing
        .filter(
          (episode) =>
            !episode.airDateUtc || new Date(episode.airDateUtc).getTime() <= now
        )
        .map((episode) => episode.id);
      await this.searchEpisodes(airedMissing);
    }

    return episodes;
  }

  private async waitForConsumedAddOptions(
    seriesId: number,
    retryOptions: EpisodeSelectionRetryOptions
  ): Promise<void> {
    const attempts = Math.max(1, retryOptions.attempts ?? 1);
    const delayMs = Math.max(0, retryOptions.delayMs ?? 0);

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const pending = Boolean((await this.getSeriesById(seriesId)).addOptions);
      if (!pending) {
        return;
      }
      if (attempt === attempts) {
        logger.warn('Sonarr is still applying add-time monitoring options.', {
          label: 'Sonarr',
          seriesId,
          attempts,
        });
        return;
      }
      logger.debug(
        'Waiting for Sonarr to finish add-time monitoring options.',
        {
          label: 'Sonarr',
          seriesId,
          attempt,
          attempts,
        }
      );
      await delay(delayMs);
    }
  }

  private buildSeasonList(
    seasons: number[],
    existingSeasons?: SonarrSeason[]
  ): SonarrSeason[] {
    if (existingSeasons) {
      const newSeasons = existingSeasons.map((season) => {
        if (seasons.includes(season.seasonNumber)) {
          season.monitored = true;
        }
        return season;
      });

      return newSeasons;
    }

    const newSeasons = seasons.map(
      (seasonNumber): SonarrSeason => ({
        seasonNumber,
        monitored: true,
      })
    );

    return newSeasons;
  }
  public removeSeries = async (tvdbId: number): Promise<void> => {
    const { id, title } = await this.getSeriesByTvdbId(tvdbId);

    if (!id) {
      logger.info(`[Sonarr] Series not in library, nothing to remove`, {
        tvdbId,
      });
      return;
    }

    try {
      await this.axios.delete(`/series/${id}`, {
        params: {
          deleteFiles: true,
          addImportExclusion: false,
        },
      });
      logger.info(`[Sonarr] Removed series ${title}`);
    } catch (e) {
      if (e?.response?.status === 404) {
        logger.info(`[Sonarr] Series already removed from Sonarr`, {
          tvdbId,
        });
        return;
      }
      throw e;
    }
  };

  public clearCache = ({
    tvdbId,
    externalId,
    title,
  }: {
    tvdbId?: number | null;
    externalId?: number | null;
    title?: string | null;
  }) => {
    if (tvdbId) {
      this.removeCache('/series/lookup', {
        term: `tvdb:${tvdbId}`,
      });
    }
    if (externalId) {
      this.removeCache(`/series/${externalId}`);
    }
    if (title) {
      this.removeCache('/series/lookup', {
        term: title,
      });
    }
  };
}

export default SonarrAPI;
