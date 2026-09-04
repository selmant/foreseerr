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

/**
 * Why a tile has no TMDB id, so the UI can say something truer than "unmapped".
 *
 * `ambiguous` is deliberately distinct from `unmapped`: several sources
 * disagreed, and showing either answer would be showing a wrong poster.
 */
export type DiscoverMappingState =
  | 'mapped'
  | 'unmapped'
  | 'ambiguous'
  | 'pending';

export interface DiscoverMappingInfo {
  state: DiscoverMappingState;
  /** Resolver that produced the id, e.g. `graph`, `anibridge`, `tmdb-find`. */
  sourceKey?: string;
  confidence?: number;
  /** Namespace and id the tile was resolved *from*, for the repair queue. */
  namespace?: string;
  externalId?: string;
}

export interface WatchlistItem {
  id: number;
  ratingKey: string;
  tmdbId?: number;
  /** Omitted when the source did not declare a type (e.g. a unified MDBList). */
  mediaType?: 'movie' | 'tv';
  title: string;
  ratings?: RatingResponse | null;
  source?: DiscoverItemSource;
  sourceUrl?: string;
  sourceId?: string;
  image?: string;
  /** Bare TMDB poster path when the id has been confirmed. */
  posterPath?: string;
  mappingState?: DiscoverMappingInfo;
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
