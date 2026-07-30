import { MediaStatus } from '@server/constants/media';

export const isSeasonFullyAvailable = (
  status: MediaStatus | undefined
): boolean => status === MediaStatus.AVAILABLE;
