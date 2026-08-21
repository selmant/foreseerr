import type { MediaStatus } from '@server/constants/media';
import type { PaginatedResponse } from './common';

export type LibraryWatchedFilter = 'unwatched' | 'inProgress' | 'played';
export type LibraryBrowseSort =
  | 'dateAdded'
  | 'title'
  | 'premiereDate'
  | 'lastPlayed';
export type LibraryBrowseOrder = 'asc' | 'desc';
export type LibraryImageType = 'primary' | 'backdrop';

export interface LibraryBrowseQuery {
  q?: string;
  mediaType?: 'movie' | 'tv';
  watched?: LibraryWatchedFilter;
  genre?: string[];
  yearFrom?: number;
  yearTo?: number;
  sort?: LibraryBrowseSort;
  order?: LibraryBrowseOrder;
  take?: number;
  skip?: number;
}

export interface LibraryTitle {
  mediaId?: number;
  tmdbId?: number;
  mediaType: 'movie' | 'tv';
  /** Primary Jellyfin id (movie, episode, or series depending on shelf row). */
  jellyfinItemId: string;
  /** What Play should send. For series rows this is the resolved episode id. */
  playItemId?: string;
  /** Series id when the row is a series or an episode. Used to open the panel. */
  jellyfinSeriesId?: string;
  title: string;
  subtitle?: string;
  overview?: string;
  mediaUrl?: string;
  status?: MediaStatus;
  /** Episode/movie progress 0–100 when resume data is present. */
  progressPercent?: number;
  /** Jellyfin resume metadata for display; native protocol v1 does not send it. */
  startPositionTicks?: number;
  year?: number;
  genres?: string[];
  watched?: boolean;
  inProgress?: boolean;
  addedAt?: string;
  lastPlayedAt?: string;
  posterUrl?: string;
  backdropUrl?: string;
  runtimeMinutes?: number;
  /** Movie id, or parent series id for episode rows. */
  inspectorItemId?: string;
  /** Unplayed episodes remaining. Set on series rows from Jellyfin UserData. */
  unplayedItemCount?: number;
  /** Episodes currently present in the Jellyfin library. Set on series rows. */
  availableEpisodeCount?: number;
}

export interface LibraryShelf {
  id: 'continue' | 'recent' | 'recent-episodes' | 'forgotten';
  title: string;
  items: LibraryTitle[];
}

export interface LibraryWatchNowResponse {
  shelves: LibraryShelf[];
  code?: 'not_linked' | 'server_unreachable' | 'unsupported_media_server';
}

export interface LibraryAvailableResponse extends PaginatedResponse {
  results: LibraryTitle[];
  code?: 'not_linked' | 'server_unreachable' | 'unsupported_media_server';
}

export interface LibraryBrowseResponse extends PaginatedResponse {
  results: LibraryTitle[];
  code?: 'not_linked' | 'server_unreachable' | 'unsupported_media_server';
}

export interface LibraryFacetsResponse {
  genres: string[];
  yearMin?: number;
  yearMax?: number;
  code?: 'not_linked' | 'server_unreachable' | 'unsupported_media_server';
}

export interface LibraryItemInspectorResponse {
  jellyfinItemId: string;
  jellyfinSeriesId?: string;
  mediaType: 'movie' | 'tv';
  title: string;
  subtitle?: string;
  overview?: string;
  year?: number;
  runtimeMinutes?: number;
  genres?: string[];
  posterUrl?: string;
  backdropUrl?: string;
  progressPercent?: number;
  watched?: boolean;
  inProgress?: boolean;
  startPositionTicks?: number;
  playItemId?: string;
  playUrl?: string;
  mediaUrl?: string;
  mediaId?: number;
  tmdbId?: number;
  status?: MediaStatus;
  seasons?: LibrarySeriesSeason[];
  code?:
    | 'not_linked'
    | 'server_unreachable'
    | 'unsupported_media_server'
    | 'not_found';
}

export interface LibrarySeriesSeason {
  jellyfinSeasonId: string;
  name: string;
  indexNumber?: number;
  episodeCount?: number;
}

export interface LibrarySeriesDetailResponse {
  jellyfinSeriesId: string;
  tmdbId?: number;
  title: string;
  playItemId?: string;
  /** Concrete Jellyfin episode URL for ordinary-browser Play next. */
  playUrl?: string;
  subtitle?: string;
  startPositionTicks?: number;
  seasons: LibrarySeriesSeason[];
  code?:
    | 'not_linked'
    | 'server_unreachable'
    | 'unsupported_media_server'
    | 'not_found';
}

export interface LibraryEpisode {
  jellyfinItemId: string;
  name: string;
  indexNumber?: number;
  parentIndexNumber?: number;
  subtitle?: string;
  overview?: string;
  progressPercent?: number;
  startPositionTicks?: number;
  /** Concrete Jellyfin episode URL for ordinary-browser playback. */
  mediaUrl?: string;
  watched?: boolean;
}

export interface LibrarySeasonEpisodesResponse {
  jellyfinSeriesId: string;
  jellyfinSeasonId: string;
  episodes: LibraryEpisode[];
  code?:
    | 'not_linked'
    | 'server_unreachable'
    | 'unsupported_media_server'
    | 'not_found';
}
