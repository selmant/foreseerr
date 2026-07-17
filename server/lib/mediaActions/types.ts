export type MediaActionMediaType = 'movie' | 'tv';

export type MediaActionProviderId = 'trakt';

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
}

export interface MediaActionProviderResult extends MediaActionStatus {
  provider: MediaActionProviderId;
  ok: boolean;
  error?: string;
}

export interface MediaActionAggregate extends MediaActionStatus {
  tmdbId: number;
  mediaType: MediaActionMediaType;
  providers: MediaActionProviderResult[];
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
