import type { NotificationAgentTypes } from '@shared/interfaces/api/userSettingsInterfaces';
import type { DiscoverFilterDefaults } from '@shared/lib/discover/filterDefaults';

/** The per-user settings the API includes on a user. */
export interface UserSettings {
  locale?: string;
  discoverRegion?: string;
  streamingRegion?: string;
  originalLanguage?: string;
  notificationTypes: Partial<NotificationAgentTypes>;
  watchlistSyncMovies?: boolean;
  watchlistSyncTv?: boolean;
  autoCompleteSkippedEpisodeEndings?: boolean;
  autoCompleteSkippedEpisodeThreshold?: number;
  watchAheadEpisodeCount?: number;
  servarrInterventionsSeenAt?: Date | null;
  discoverFilterDefaults?: DiscoverFilterDefaults;
}
