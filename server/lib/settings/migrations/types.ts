import type {
  AllSettings,
  JellyfinSettings,
  MainSettings,
  RadarrSettings,
  SonarrSettings,
} from '@server/lib/settings';

/**
 * Settings are read before defaults are regenerated, so an older settings
 * file can omit fields that are required by the current AllSettings shape.
 * Keep that legacy input explicit instead of using `any` in each migration.
 */
export type MigrationSettings = Omit<AllSettings, 'network'> & {
  jellyfin: JellyfinSettings & { hostname?: string };
  main: MainSettings & {
    region?: string;
    csrfProtection?: boolean;
    trustProxy?: boolean;
    forceIpv4First?: boolean;
    proxy?: AllSettings['network']['proxy'];
    hideBlacklisted?: boolean;
    blacklistedTags?: string;
    blacklistedTagsLimit?: number;
  };
  notifications: AllSettings['notifications'] & {
    agents: AllSettings['notifications']['agents'] & {
      lunasea?: unknown;
    };
  };
  radarr: (RadarrSettings & { tagRequests?: boolean })[];
  sonarr: (SonarrSettings & { tagRequests?: boolean })[];
  jobs: AllSettings['jobs'] &
    Record<string, AllSettings['jobs'][keyof AllSettings['jobs']]>;
  network?: Partial<AllSettings['network']>;
};

export const asAllSettings = (settings: MigrationSettings): AllSettings =>
  settings as AllSettings;
