import type { MediaStatus } from '@server/constants/media';
import type { PaginatedResponse } from './common';

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
  subtitle?: string;
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
