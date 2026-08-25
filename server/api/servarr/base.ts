import ExternalAPI from '@server/api/externalapi';
import type { AvailableCacheIds } from '@server/lib/cache';
import cacheManager from '@server/lib/cache';
import { getSettings, type DVRSettings } from '@server/lib/settings';

export interface SystemStatus {
  version: string;
  buildTime: Date;
  isDebug: boolean;
  isProduction: boolean;
  isAdmin: boolean;
  isUserInteractive: boolean;
  startupPath: string;
  appData: string;
  osName: string;
  osVersion: string;
  isNetCore: boolean;
  isMono: boolean;
  isLinux: boolean;
  isOsx: boolean;
  isWindows: boolean;
  isDocker: boolean;
  mode: string;
  branch: string;
  authentication: string;
  sqliteVersion: string;
  migrationVersion: number;
  urlBase: string;
  runtimeVersion: string;
  runtimeName: string;
  startTime: Date;
  packageUpdateMechanism: string;
}

export interface RootFolder {
  id: number;
  path: string;
  freeSpace: number;
  totalSpace: number;
  unmappedFolders: {
    name: string;
    path: string;
  }[];
}

export interface QualityProfile {
  id: number;
  name: string;
}

export interface QueueItem {
  size: number;
  title: string;
  sizeleft: number;
  timeleft: string;
  estimatedCompletionTime: string;
  status: string;
  trackedDownloadStatus: string;
  trackedDownloadState: string;
  downloadId: string;
  protocol: string;
  downloadClient: string;
  indexer: string;
  id: number;
  outputPath?: string;
}

/** The queue fields used to decide whether Arr requires interactive import. */
export interface QueueDetailsItem {
  title: string;
  downloadId?: string;
  outputPath?: string;
  status?: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  statusMessages?: { title: string; messages: string[] }[];
}

export interface ServarrCommand {
  id: number;
  name: string;
  status: string;
  message?: string;
  queued?: string;
  started?: string;
  ended?: string;
}

export interface Tag {
  id: number;
  label: string;
}

/** Fields Sonarr/Radarr accept on POST /release, including forced grabs. */
export interface ServarrGrabRequest {
  guid: string;
  indexerId: number;
  seriesId?: number;
  movieId?: number;
  episodeId?: number;
  episodeIds?: number[];
  quality?: unknown;
  languages?: unknown;
  shouldOverride?: boolean;
}

interface QueueResponse<QueueItemAppendT> {
  page: number;
  pageSize: number;
  sortKey: string;
  sortDirection: string;
  totalRecords: number;
  records: (QueueItem & QueueItemAppendT)[];
}

const QUEUE_PAGE_SIZE = 250;
const QUEUE_MAX_PAGES = 40;

/**
 * Interactive indexer search waits on every configured indexer. The global
 * API timeout (still 10s on many installs, even after the 60s default bump)
 * is too short for that. 0 means "no timeout".
 */
export const INTERACTIVE_RELEASE_SEARCH_TIMEOUT_MS = 120_000;

export function interactiveReleaseSearchTimeout(
  configuredTimeout = getSettings().network.apiRequestTimeout
): number {
  if (configuredTimeout === 0) {
    return 0;
  }
  return Math.max(configuredTimeout, INTERACTIVE_RELEASE_SEARCH_TIMEOUT_MS);
}

/**
 * Arr GET /manualimport treats seriesId/movieId as "scan the library folder".
 * That 500s when the folder does not exist yet. Queue-based interactive import
 * must send downloadId/folder instead so Arr inspects the completed download.
 */
export function manualImportQuery(params: {
  seriesId?: number;
  movieId?: number;
  folder?: string;
  downloadId?: string;
}): Record<string, string | number | boolean> {
  const query: Record<string, string | number | boolean> = {
    filterExistingFiles: true,
  };
  if (params.downloadId || params.folder) {
    if (params.folder) query.folder = params.folder;
    if (params.downloadId) query.downloadId = params.downloadId;
    return query;
  }
  if (params.seriesId != null) query.seriesId = params.seriesId;
  if (params.movieId != null) query.movieId = params.movieId;
  return query;
}

class ServarrBase<QueueItemAppendT> extends ExternalAPI {
  static buildUrl(settings: DVRSettings, path?: string): string {
    return `${settings.useSsl ? 'https' : 'http'}://${settings.hostname}:${
      settings.port
    }${settings.baseUrl ?? ''}${path}`;
  }

  protected apiName: string;

  constructor({
    url,
    apiKey,
    cacheName,
    apiName,
  }: {
    url: string;
    apiKey: string;
    cacheName: AvailableCacheIds;
    apiName: string;
  }) {
    const timeout = getSettings().network.apiRequestTimeout;

    super(
      url,
      {
        apikey: apiKey,
      },
      {
        nodeCache: cacheManager.getCache(cacheName).data,
        timeout,
      }
    );

    this.apiName = apiName;
  }

  public getSystemStatus = async (): Promise<SystemStatus> => {
    try {
      const response = await this.axios.get<SystemStatus>('/system/status');

      return response.data;
    } catch (e) {
      throw new Error(
        `[${this.apiName}] Failed to retrieve system status: ${e.message}`,
        { cause: e }
      );
    }
  };

  public getProfiles = async (): Promise<QualityProfile[]> => {
    try {
      const data = await this.getRolling<QualityProfile[]>(
        `/qualityProfile`,
        undefined,
        3600
      );

      return data;
    } catch (e) {
      throw new Error(
        `[${this.apiName}] Failed to retrieve profiles: ${e.message}`,
        { cause: e }
      );
    }
  };

  public getRootFolders = async (): Promise<RootFolder[]> => {
    try {
      const data = await this.getRolling<RootFolder[]>(
        `/rootfolder`,
        undefined,
        3600
      );

      return data;
    } catch (e) {
      throw new Error(
        `[${this.apiName}] Failed to retrieve root folders: ${e.message}`,
        { cause: e }
      );
    }
  };

  public getQueue = async (): Promise<(QueueItem & QueueItemAppendT)[]> => {
    try {
      const records: (QueueItem & QueueItemAppendT)[] = [];
      for (let page = 1; page <= QUEUE_MAX_PAGES; page += 1) {
        const response = await this.axios.get<QueueResponse<QueueItemAppendT>>(
          `/queue`,
          {
            params: {
              page,
              pageSize: QUEUE_PAGE_SIZE,
              includeEpisode: true,
            },
          }
        );
        const pageRecords = response.data.records ?? [];
        records.push(...pageRecords);
        const totalRecords = response.data.totalRecords ?? records.length;
        if (
          records.length >= totalRecords ||
          pageRecords.length < QUEUE_PAGE_SIZE
        ) {
          break;
        }
      }
      return records;
    } catch (e) {
      throw new Error(
        `[${this.apiName}] Failed to retrieve queue: ${e.message}`,
        { cause: e }
      );
    }
  };

  public getTags = async (): Promise<Tag[]> => {
    try {
      const response = await this.axios.get<Tag[]>(`/tag`);

      return response.data;
    } catch (e) {
      throw new Error(
        `[${this.apiName}] Failed to retrieve tags: ${e.message}`,
        { cause: e }
      );
    }
  };

  public createTag = async ({ label }: { label: string }): Promise<Tag> => {
    try {
      const response = await this.axios.post<Tag>(`/tag`, {
        label,
      });

      return response.data;
    } catch (e) {
      throw new Error(`[${this.apiName}] Failed to create tag: ${e.message}`, {
        cause: e,
      });
    }
  };

  public renameTag = async ({
    id,
    label,
  }: {
    id: number;
    label: string;
  }): Promise<Tag> => {
    try {
      const response = await this.axios.put<Tag>(`/tag/${id}`, {
        id,
        label,
      });

      return response.data;
    } catch (e) {
      throw new Error(`[${this.apiName}] Failed to rename tag: ${e.message}`, {
        cause: e,
      });
    }
  };

  async refreshMonitoredDownloads(): Promise<void> {
    await this.runCommand('RefreshMonitoredDownloads', {});
  }

  protected async runCommand(
    commandName: string,
    options: Record<string, unknown>
  ): Promise<ServarrCommand> {
    try {
      const response = await this.axios.post<ServarrCommand>(`/command`, {
        name: commandName,
        ...options,
      });
      return response.data;
    } catch (e) {
      throw new Error(`[${this.apiName}] Failed to run command: ${e.message}`, {
        cause: e,
      });
    }
  }

  public async getCommand(commandId: number): Promise<ServarrCommand> {
    const response = await this.axios.get<ServarrCommand>(
      `/command/${commandId}`
    );
    return response.data;
  }

  public async grabRelease(release: ServarrGrabRequest): Promise<void> {
    const body: Record<string, unknown> = {
      guid: release.guid,
      indexerId: release.indexerId,
    };
    if (release.seriesId != null) body.seriesId = release.seriesId;
    if (release.movieId != null) body.movieId = release.movieId;
    if (release.episodeId != null) body.episodeId = release.episodeId;
    if (release.episodeIds?.length) body.episodeIds = release.episodeIds;
    if (release.shouldOverride) {
      body.shouldOverride = true;
      if (release.quality) body.quality = release.quality;
      if (release.languages) body.languages = release.languages;
    }
    await this.axios.post('/release', body);
  }
}

export default ServarrBase;
