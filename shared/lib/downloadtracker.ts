import type { MediaType } from '@shared/constants/media';

interface EpisodeNumberResult {
  seasonNumber: number;
  episodeNumber: number;
  absoluteEpisodeNumber: number;
  id: number;
}

/** One season of a Sonarr 5 download. */
export interface DownloadSeason {
  seasonNumber: number;
  episodeCount: number;
  episodesWithFilesCount: number;
}

/**
 * One episode (Sonarr) or movie (Radarr) being downloaded. A download of
 * several episodes is listed once per episode, all with its `downloadId`.
 */
export interface DownloadingItem {
  mediaType: MediaType;
  externalId: number;
  size: number;
  sizeLeft: number;
  status: string;
  timeLeft: string;
  estimatedCompletionTime: Date;
  title: string;
  downloadId: string;
  episode?: EpisodeNumberResult;
  /** Sonarr 5: every season the whole download covers. */
  seasons?: DownloadSeason[];
  /** Sonarr 5: the download is a full-season pack. */
  isFullSeason?: boolean;
  /** Sonarr 5: how many of the download's episodes already have a file. */
  episodesWithFilesCount?: number;
}
