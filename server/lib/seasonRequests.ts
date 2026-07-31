import { MediaStatus } from '@server/constants/media';

export const isSeasonFullyAvailable = (
  status: MediaStatus | undefined
): boolean => status === MediaStatus.AVAILABLE;

/**
 * A season being processed by Sonarr is normally already covered. The one
 * exception is a partial episode request: users must be able to upgrade that
 * request to the whole season.
 */
export const isSeasonCoveredForFullRequest = (
  status: MediaStatus | undefined,
  hasActiveEpisodeRequest: boolean
): boolean =>
  isSeasonFullyAvailable(status) ||
  (status === MediaStatus.PROCESSING && !hasActiveEpisodeRequest);
