import type { MediaStatus } from '@shared/constants/media';

/** Per-season availability of a TV media item. */
interface Season {
  id: number;
  seasonNumber: number;
  status: MediaStatus;
  status4k: MediaStatus;
  createdAt: Date;
  updatedAt: Date;
}

export default Season;
