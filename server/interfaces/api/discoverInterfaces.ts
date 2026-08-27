export interface GenreSliderItem {
  id: number;
  name: string;
  backdrops: string[];
}

export type DiscoverItemSource =
  | 'trakt'
  | 'anilist'
  | 'simkl'
  | 'mdblist'
  | 'plex';

export interface WatchlistItem {
  id: number;
  ratingKey: string;
  tmdbId?: number;
  mediaType: 'movie' | 'tv';
  title: string;
  ratings?: RatingResponse | null;
  source?: DiscoverItemSource;
  sourceUrl?: string;
  sourceId?: string;
  image?: string;
}

export interface WatchlistResponse {
  page: number;
  /** Exact totals when known (e.g. Plex). Omit for filtered/mixed Trakt. */
  totalPages?: number;
  totalResults?: number;
  /** Continuation signal when exact totals are unknown (Phase 0 contract). */
  hasMore?: boolean;
  results: WatchlistItem[];
  providerState?: {
    source: DiscoverItemSource;
    stale: boolean;
    lastSuccessfulSyncAt?: string;
  };
}
import type { RatingResponse } from '@server/api/ratings';
