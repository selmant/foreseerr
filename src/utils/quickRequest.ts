import type { MediaRequest } from '@server/entity/MediaRequest';
import axios from 'axios';
import { mutate } from 'swr';

/**
 * TV request modes for the split request control.
 * `episodes` is reserved for a future single-episode request UI.
 */
export type TvRequestMode = 'season1' | 'all' | 'episodes' | 'modal';

export type QuickTvRequestOptions = {
  tmdbId: number;
  seasons: number[] | 'all';
  is4k?: boolean;
  tvdbId?: number;
};

export type QuickMovieRequestOptions = {
  tmdbId: number;
  is4k?: boolean;
};

const refreshRequestCaches = () => {
  mutate('/api/v1/request/count');
  mutate('/api/v1/request?filter=all&take=10&sort=modified&skip=0');
};

/**
 * Instant movie request (no modal). Server applies defaults.
 */
export const quickRequestMovie = async ({
  tmdbId,
  is4k = false,
}: QuickMovieRequestOptions): Promise<MediaRequest> => {
  const response = await axios.post<MediaRequest>('/api/v1/request', {
    mediaId: tmdbId,
    mediaType: 'movie',
    is4k,
  });

  refreshRequestCaches();
  return response.data;
};

/**
 * Instant TV request (no modal). Server applies defaults / anime routing.
 */
export const quickRequestTvSeasons = async ({
  tmdbId,
  seasons,
  is4k = false,
  tvdbId,
}: QuickTvRequestOptions): Promise<MediaRequest> => {
  const response = await axios.post<MediaRequest>('/api/v1/request', {
    mediaId: tmdbId,
    mediaType: 'tv',
    is4k,
    seasons,
    ...(tvdbId != null ? { tvdbId } : {}),
  });

  refreshRequestCaches();
  return response.data;
};
