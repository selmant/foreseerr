import type { MediaStatus, MediaType } from '@shared/constants/media';
import type Issue from '@shared/entity/Issue';
import type { MediaRequest } from '@shared/entity/MediaRequest';
import type Season from '@shared/entity/Season';
import type { Watchlist } from '@shared/entity/Watchlist';
import type { DownloadingItem } from '@shared/lib/downloadtracker';

/** A tracked title as the API returns it (`mediaInfo` on TMDB results). */
interface Media {
  id: number;
  mediaType: MediaType;
  tmdbId: number;
  tvdbId?: number;
  imdbId?: string;
  status: MediaStatus;
  status4k: MediaStatus;
  requests: MediaRequest[];
  watchlists?: null | Watchlist[];
  seasons: Season[];
  issues: Issue[];
  createdAt: Date;
  updatedAt: Date;
  /** When the media was last added to the library. */
  lastSeasonChange: Date;
  /** When the media was added to the library; null before the first sync. */
  mediaAddedAt: Date;
  serviceId?: number | null;
  serviceId4k?: number | null;
  externalServiceId?: number | null;
  externalServiceId4k?: number | null;
  externalServiceSlug?: string | null;
  externalServiceSlug4k?: string | null;
  ratingKey?: string | null;
  ratingKey4k?: string | null;
  jellyfinMediaId?: string | null;
  jellyfinMediaId4k?: string | null;
  serviceUrl?: string;
  serviceUrl4k?: string;
  hasActiveRequest?: boolean;
  downloadStatus?: DownloadingItem[];
  downloadStatus4k?: DownloadingItem[];
  mediaUrl?: string;
  mediaUrl4k?: string;
  iOSPlexUrl?: string;
  iOSPlexUrl4k?: string;
  tautulliUrl?: string;
  tautulliUrl4k?: string;
}

export default Media;
