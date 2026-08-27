export type MediaActionMediaType = 'movie' | 'tv';

export type MediaActionProviderId = 'trakt' | 'jellyfin' | 'anilist' | 'simkl';

export interface MediaActionOperationCapabilities {
  readWatched: boolean;
  writeWatched: boolean;
  readRating: boolean;
  writeRating: boolean;
}

export const TRAKT_MEDIA_ACTION_CAPABILITIES: MediaActionOperationCapabilities =
  {
    readWatched: true,
    writeWatched: true,
    readRating: true,
    writeRating: true,
  };

export const JELLYFIN_MEDIA_ACTION_CAPABILITIES: MediaActionOperationCapabilities =
  {
    readWatched: true,
    writeWatched: true,
    readRating: false,
    writeRating: false,
  };

export const ANILIST_MEDIA_ACTION_CAPABILITIES: MediaActionOperationCapabilities =
  {
    readWatched: true,
    writeWatched: true,
    readRating: true,
    writeRating: true,
  };

export const SIMKL_MEDIA_ACTION_CAPABILITIES: MediaActionOperationCapabilities =
  {
    readWatched: true,
    writeWatched: true,
    readRating: true,
    writeRating: true,
  };

export type MediaActionOperationCapability =
  keyof MediaActionOperationCapabilities;

export interface MediaItemRef {
  mediaType: MediaActionMediaType;
  tmdbId: number;
}

export interface MediaActionStatus {
  watched: boolean;
  /** Provider-native score (Trakt: 1–10). */
  rating: number | null;
  /** UI half-stars (0.5–5). */
  ratingStars: number | null;
  /** A read failure for this provider/item in a batched status response. */
  error?: string;
}

export interface MediaActionProviderResult extends MediaActionStatus {
  provider: MediaActionProviderId;
  ok: boolean;
  error?: string;
}

export type MediaActionWriteOutcome = 'success' | 'partial' | 'failure';

export type MediaActionUnavailableReason =
  | 'no_provider'
  | 'not_mapped'
  | 'provider_error'
  | 'unsupported';

export interface MediaActionOperationAvailability {
  available: boolean;
  /** Present when the operation cannot be applied to this specific title. */
  reason?: MediaActionUnavailableReason;
}

export interface MediaActionItemAvailability {
  watched: MediaActionOperationAvailability;
  rating: MediaActionOperationAvailability;
}

export interface MediaActionAggregate extends MediaActionStatus {
  tmdbId: number;
  mediaType: MediaActionMediaType;
  providers: MediaActionProviderResult[];
  /** Per-item write eligibility; unlike /capabilities this accounts for mappings. */
  actions: MediaActionItemAvailability;
  /** Present on write responses only. */
  outcome?: MediaActionWriteOutcome;
}

export interface MarkWatchedOptions {
  watchedAt?: 'now' | 'release';
  ratingStars?: number;
}

export interface UnmarkWatchedOptions {
  removeRating?: boolean;
}

export interface RateOptions {
  ratingStars: number;
}

export interface MediaActionProvider {
  readonly id: MediaActionProviderId;
  readonly capabilities: MediaActionOperationCapabilities;
  isAvailable(userId: number): Promise<boolean>;
  getStatus(userId: number, item: MediaItemRef): Promise<MediaActionStatus>;
  getStatuses(
    userId: number,
    items: MediaItemRef[]
  ): Promise<(MediaItemRef & MediaActionStatus)[]>;
  markWatched(
    userId: number,
    item: MediaItemRef,
    options?: MarkWatchedOptions
  ): Promise<MediaActionStatus>;
  unmarkWatched(
    userId: number,
    item: MediaItemRef,
    options?: UnmarkWatchedOptions
  ): Promise<MediaActionStatus>;
  rate(
    userId: number,
    item: MediaItemRef,
    options: RateOptions
  ): Promise<MediaActionStatus>;
}
