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
  state: 'active' | 'rejecting' | 'importing' | 'resolved';
  /** `tracks`: an imported file without a required audio or subtitle language. */
  kind: 'queue' | 'tracks';
  resolution?:
    | 'recovered'
    | 'disappeared'
    | 'manual_blocklist'
    | 'automatic_blocklist'
    | 'manual_import'
    | 'replaced'
    | 'kept';
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
