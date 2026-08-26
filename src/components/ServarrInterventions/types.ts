export type ServarrIntervention = {
  id: number;
  serviceType: 'radarr' | 'sonarr';
  serviceId: number;
  serviceName: string;
  is4k: boolean;
  mediaId: number;
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  releaseTitle: string;
  warningMessages: string[];
  manualImportCapable: boolean;
  state: 'active' | 'rejecting' | 'resolved';
  resolution?:
    | 'recovered'
    | 'disappeared'
    | 'manual_blocklist'
    | 'automatic_blocklist'
    | 'manual_import';
  cleanupError?: string;
  firstSeenAt: string;
  cleanupDeadlineAt: string;
  resolvedAt?: string;
  actor?: { id: number; displayName: string } | null;
};

export type InterventionResults = {
  pageInfo: { pages: number; pageSize: number; results: number; page: number };
  results: ServarrIntervention[];
};
