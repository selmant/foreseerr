import type Media from '@shared/entity/Media';
import type { MediaRequest } from '@shared/entity/MediaRequest';
import type { User } from '@shared/entity/User';
import type { PaginatedResponse } from './common';

export interface UserResultsResponse extends PaginatedResponse {
  results: User[];
}

export interface UserRequestsResponse extends PaginatedResponse {
  results: MediaRequest[];
}

export interface QuotaStatus {
  days?: number;
  limit?: number;
  used: number;
  remaining?: number;
  restricted: boolean;
}

export interface QuotaResponse {
  movie: QuotaStatus;
  tv: QuotaStatus;
}

/** What one Sonarr 5 server holds of the series tagged with the user. */
export interface SonarrStorageServer {
  id: number;
  name: string;
  is4k: boolean;
  seriesCount: number;
  /** Episodes with a file. */
  episodeCount: number;
  episodeFileCount: number;
  sizeOnDisk: number;
}

/** Servers that tag requests and speak Sonarr's API v5; others are absent. */
export interface SonarrStorageResponse {
  servers: SonarrStorageServer[];
}

export interface UserWatchDataResponse {
  recentlyWatched: Media[];
  playCount: number;
}
