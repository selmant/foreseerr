import type { UserType } from '@shared/constants/user';
import type Issue from '@shared/entity/Issue';
import type { MediaRequest } from '@shared/entity/MediaRequest';
import type { UserPushSubscription } from '@shared/entity/UserPushSubscription';
import type { UserSettings } from '@shared/entity/UserSettings';
import type { Watchlist } from '@shared/entity/Watchlist';

/**
 * A user as the API returns it. Credentials (password, reset GUID, Plex and
 * Jellyfin tokens) are never serialized and are not part of this type.
 */
export interface User {
  id: number;
  displayName: string;
  /** Only sent to the user themselves and to user managers. */
  email: string;
  plexUsername?: string | null;
  jellyfinUsername?: string | null;
  username?: string;
  recoveryLinkExpirationDate?: Date | null;
  userType: UserType;
  plexId?: number | null;
  jellyfinUserId?: string | null;
  permissions: number;
  avatar: string;
  avatarETag?: string | null;
  avatarVersion?: string | null;
  requestCount: number;
  requests?: MediaRequest[];
  watchlists?: Watchlist[];
  movieQuotaLimit?: number;
  movieQuotaDays?: number;
  tvQuotaLimit?: number;
  tvQuotaDays?: number;
  settings?: UserSettings;
  pushSubscriptions?: UserPushSubscription[];
  createdIssues?: Issue[];
  createdAt: Date;
  updatedAt: Date;
  warnings: string[];
}
