import type { MediaRequestStatus } from '@shared/constants/media';
import type { MediaRequest } from '@shared/entity/MediaRequest';

/** One requested episode of an episode or watch-ahead request. */
interface EpisodeRequest {
  id: number;
  tvdbId: number;
  seasonNumber: number;
  episodeNumber: number;
  title?: string;
  airDate?: string;
  status: MediaRequestStatus;
  searchTriggeredAt?: Date;
  /**
   * Set once the sync has made Sonarr monitor this watch-ahead episode.
   * After that, Sonarr's monitored flag wins, so an episode someone else
   * unmonitored stays unmonitored.
   */
  monitoredAt?: Date;
  /**
   * Set while a watch-ahead episode without a file is unmonitored after
   * Foreseerr monitored it, for example because a cleanup tool removed it.
   */
  unmonitoredAt?: Date | null;
  /** Parent request; absent when nested inside that request. */
  request?: MediaRequest;
  createdAt: Date;
  updatedAt: Date;
}

export default EpisodeRequest;
