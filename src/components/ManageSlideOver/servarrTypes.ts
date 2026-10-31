export type Episode = {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  hasFile: boolean;
  monitored: boolean;
  queueStatus?: 'downloading' | 'queued' | 'importing' | 'manual-import';
};

export type ServarrContext = {
  mediaType: 'movie' | 'tv';
  service: { type: string; name: string };
  seasons?: { seasonNumber: number; episodes: Episode[] }[];
  nativeUrl?: string;
};

export type ImportSource = { token: string; kind: 'queue'; label: string };
/**
 * An import warning: `reason` is the Arr's text; `code` is Sonarr 5's
 * typed reason (e.g. `executableFile`).
 */
export type Rejection = { reason: string; type?: string; code?: string };
/** A Sonarr 5 release rejection with its typed reason (e.g. `blocklisted`). */
export type ReleaseRejection = {
  message: string;
  code?: string;
  type?: string;
};

export type Release = {
  token: string;
  title: string;
  quality?: string;
  size: number;
  ageHours: number;
  indexer: string;
  protocol: string;
  seeders?: number;
  rejections: string[];
  /** Sonarr 5: the rejections with their typed reasons. */
  rejectionDetails?: ReleaseRejection[];
  rejected: boolean;
  downloadAllowed: boolean;
  /** Sonarr 5: when the release was grabbed before, and when that failed. */
  history?: { grabbed?: string; failed?: string };
  /** Sonarr 5: a pack of several seasons, which it won't import itself. */
  multiSeason?: boolean;
  seasonNumbers?: number[];
};

export type ImportCandidate = {
  token: string;
  source?: string;
  name: string;
  relativePath?: string;
  folderName?: string;
  size: number;
  quality?: string;
  languages: string[];
  releaseGroup?: string;
  customFormats: string[];
  customFormatScore?: number;
  rejections: Rejection[];
  seasonNumber?: number;
  episodes?: Episode[];
  complete: boolean;
  /** Flagged as potentially dangerous or executable: never importable. */
  unsafe?: 'dangerousFile' | 'executableFile';
  /** From a multi-season download: import only to episodes picked for it. */
  multiSeason?: boolean;
};

export const formatSize = (size: number) =>
  `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
