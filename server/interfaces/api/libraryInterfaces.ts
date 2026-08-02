import type { MediaStatus } from '@server/constants/media';
import type { PaginatedResponse } from './common';

export interface LibraryTitle {
  mediaId?: number;
  tmdbId?: number;
  mediaType: 'movie' | 'tv';
  jellyfinItemId: string;
  title: string;
  subtitle?: string;
  overview?: string;
  mediaUrl?: string;
  status?: MediaStatus;
  /** Episode/movie progress 0–100 when resume data is present. */
  progressPercent?: number;
}

export interface LibraryShelf {
  id: 'continue' | 'recent' | 'forgotten';
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
