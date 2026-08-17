import type { MediaRequest } from '@server/entity/MediaRequest';
import type { EpisodeSelection } from '@server/interfaces/api/requestInterfaces';
import axios from 'axios';
import { mutate } from 'swr';

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

export type QuickEpisodeRequestOptions = {
  tmdbId: number;
  selection: EpisodeSelection;
  is4k?: boolean;
  tvdbId?: number;
};

export const tvEpisodeQuotaUnits = 1;

export const isTvQuotaExhausted = (
  quota?: { limit?: number; remaining?: number; restricted: boolean },
  units = tvEpisodeQuotaUnits
): boolean =>
  Boolean(quota?.limit && (quota.restricted || (quota.remaining ?? 0) < units));

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

/**
 * Instant episode request (no modal). Server resolves and validates TVDB IDs.
 */
export const quickRequestTvEpisodes = async ({
  tmdbId,
  selection,
  is4k = false,
  tvdbId,
}: QuickEpisodeRequestOptions): Promise<MediaRequest> => {
  const response = await axios.post<MediaRequest>('/api/v1/request', {
    mediaId: tmdbId,
    mediaType: 'tv',
    is4k,
    episodeSelection: selection,
    ...(tvdbId != null ? { tvdbId } : {}),
  });

  refreshRequestCaches();
  return response.data;
};
