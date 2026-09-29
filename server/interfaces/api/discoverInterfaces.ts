import type { RatingResponse } from '@server/api/ratings';
import type { MediaStatus } from '@server/constants/media';
import type DiscoverSlider from '@server/entity/DiscoverSlider';

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
  /** Bare TMDB backdrop path, from the same confirm probe as `posterPath`. */
  backdropPath?: string;
  /** Movie release date (`YYYY-MM-DD`) from TMDB. */
  releaseDate?: string;
  /** Series first air date (`YYYY-MM-DD`) from TMDB. */
  firstAirDate?: string;
  /** Library/request status when Foreseerr already tracks the title. */
  mediaInfo?: WatchlistItemMediaInfo;
  hasActiveRequest?: boolean;
  mappingState?: DiscoverMappingInfo;
}

/** The subset of the Media entity a list tile carries, as on Seerr results. */
export interface WatchlistItemMediaInfo {
  id: number;
  tmdbId: number;
  status: MediaStatus;
  status4k: MediaStatus;
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

/**
 * A slider as `GET /settings/discover` returns it. The extra fields are
 * computed per response and never stored.
 */
export type DiscoverSliderResponse = DiscoverSlider & {
  /**
   * API path and query for one page of this slider's results, without `page`.
   * Absent for rows clients draw themselves and rows missing their data.
   */
  endpoint?: string;
  /** English name for built-in rows Foreseerr names itself. */
  defaultTitle?: string;
};
