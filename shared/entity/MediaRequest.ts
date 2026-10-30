import type { MediaRequestStatus, MediaType } from '@shared/constants/media';
import type EpisodeRequest from '@shared/entity/EpisodeRequest';
import type Media from '@shared/entity/Media';
import type SeasonRequest from '@shared/entity/SeasonRequest';
import type { User } from '@shared/entity/User';

/** A movie or TV request as the API returns it. */
export interface MediaRequest {
  id: number;
  status: MediaRequestStatus;
  media: Media;
  requestedBy: User;
  modifiedBy?: User;
  createdAt: Date;
  updatedAt: Date;
  type: MediaType;
  seasonCount: number;
  seasons: SeasonRequest[];
  episodes: EpisodeRequest[];
  episodeSelectionType?: 'single' | 'range' | 'after' | 'watchAhead';
  episodeStartTvdbId?: number;
  episodeEndTvdbId?: number;
  watchAheadCount?: number;
  /**
   * Set while every episode in the watch-ahead window was removed from
   * Sonarr's monitoring, so the request is no longer downloading anything.
   */
  watchAheadInactiveAt?: Date | null;
  /**
   * Logical series/quality key protected by the active-ongoing partial index.
   */
  ongoingEpisodeRequestKey?: string;
  tvQuotaUnits: number;
  is4k: boolean;
  serverId: number;
  profileId: number;
  rootFolder: string;
  languageProfileId: number;
  tags?: number[];
  isAutoRequest: boolean;
  ignoreQuota: boolean;
}
