import type { RatingBadgeSettings } from '@shared/constants/ratingBadges';
import type { PaginatedResponse } from './common';

/** One cached hostname, as the `dns-caching` package reports it. */
export interface DnsEntry {
  addresses: {
    ipv4: number;
    ipv6: number;
  };
  activeAddress: string;
  family: number;
  age: number;
  ttl: number;
  hits: number;
  misses: number;
}

export type DnsEntries = Record<string, DnsEntry>;

/** Aggregate DNS cache counters, as the `dns-caching` package reports them. */
export interface DnsStats {
  size: number;
  cacheMaxEntries: number;
  hits: number;
  misses: number;
  failures: number;
  ipv4Fallbacks: number;
  hitRate: number;
}

export type LogMessage = {
  timestamp: string;
  level: string;
  label?: string;
  message: string;
  data?: Record<string, unknown>;
};

export interface LogsResultsResponse extends PaginatedResponse {
  results: LogMessage[];
}

export interface SettingsAboutResponse {
  version: string;
  totalRequests: number;
  totalMediaItems: number;
  tz?: string;
  appDataPath: string;
}

export interface PublicSettingsResponse {
  jellyfinHost?: string;
  jellyfinExternalHost?: string;
  jellyfinServerName?: string;
  jellyfinForgotPasswordUrl?: string;
  initialized: boolean;
  applicationTitle: string;
  applicationUrl: string;
  hideAvailable: boolean;
  hideBlocklisted: boolean;
  hideRequested: boolean;
  localLogin: boolean;
  mediaServerLogin: boolean;
  movie4kEnabled: boolean;
  series4kEnabled: boolean;
  movieInstantRequestEnabled: boolean;
  movie4kInstantRequestEnabled: boolean;
  seriesInstantRequestEnabled: boolean;
  series4kInstantRequestEnabled: boolean;
  discoverRegion: string;
  streamingRegion: string;
  originalLanguage: string;
  mediaServerType: number;
  partialRequestsEnabled: boolean;
  episodeRequestsEnabled: boolean;
  enableSpecialEpisodes: boolean;
  cacheImages: boolean;
  vapidPublic: string;
  enablePushRegistration: boolean;
  locale: string;
  emailEnabled: boolean;
  newPlexLogin: boolean;
  youtubeUrl: string;
  versionCheck: boolean;
  plexClientIdentifier: string;
  traktConfigured: boolean;
  anilistConfigured: boolean;
  simklConfigured: boolean;
  mediaActionsTraktEnabled: boolean;
  mediaActionsJellyfinEnabled: boolean;
  mediaActionsAnilistEnabled: boolean;
  mediaActionsSimklEnabled: boolean;
  mdblistConfigured: boolean;
  /** Served by the Jellyfin sidecar plugin under Jellyfin's own origin. */
  pluginMode?: boolean;
  ratingBadges: RatingBadgeSettings;
}

export interface CacheItem {
  id: string;
  name: string;
  stats: {
    hits: number;
    misses: number;
    keys: number;
    ksize: number;
    vsize: number;
  };
}

export interface ImageCacheGroupStats {
  size: number;
  imageCount: number;
}

export type ImageCacheSource = 'tmdb' | 'tvdb' | 'avatar' | 'anilist' | 'simkl';

export interface CacheResponse {
  apiCaches: CacheItem[];
  imageCache: Record<ImageCacheSource, ImageCacheGroupStats>;
  images?: {
    usedBytes: number;
    entries: number;
    highWaterBytes: number;
    trimTargetBytes: number;
    idleDays: number;
  };
  dnsCache: {
    stats: DnsStats | undefined;
    entries: DnsEntries | undefined;
  };
}

export interface StatusResponse {
  version: string;
  commitTag: string;
  updateAvailable?: boolean;
  commitsBehind?: number;
  restartRequired: boolean;
  runtime?: 'desktop';
  managed?: boolean;
  jobsStarted?: boolean;
  stopping?: boolean;
}
