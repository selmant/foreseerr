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
export type Rejection = { reason: string; type?: string };

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
  rejected: boolean;
  downloadAllowed: boolean;
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
};

export const formatSize = (size: number) =>
  `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
