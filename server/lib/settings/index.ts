import type { RatingBadgeSettings } from '@server/constants/ratingBadges';
import { DEFAULT_RATING_BADGE_SETTINGS } from '@server/constants/ratingBadges';
import { MediaServerType } from '@server/constants/server';
import {
  effectiveApplicationUrl,
  isDesktopRuntime,
} from '@server/lib/desktopState';
import { Permission } from '@server/lib/permissions';
import { runMigrations } from '@server/lib/settings/migrator';
import type { AvailableLocale } from '@server/types/languages';
import { randomBytes, randomUUID } from 'crypto';
import fs from 'fs/promises';
import { mergeWith } from 'lodash';
import path from 'path';
import webpush from 'web-push';

export { DEFAULT_RATING_BADGE_SETTINGS };
export type { RatingBadgeSettings };

// Prevents stale array entries when incoming data has fewer elements
const mergeSettings = <T>(current: T, incoming: Partial<T>): T =>
  mergeWith({}, current, incoming, (_objValue, srcValue) =>
    Array.isArray(srcValue) ? srcValue : undefined
  ) as T;

const isManagedApplicationUrl = (value: unknown, origin: string): boolean => {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).origin === origin;
  } catch {
    return false;
  }
};

export interface Library {
  id: string;
  name: string;
  enabled: boolean;
  type: 'show' | 'movie';
  lastScan?: number;
}

export interface Region {
  iso_3166_1: string;
  english_name: string;
  name?: string;
}

export interface Language {
  iso_639_1: string;
  english_name: string;
  name: string;
}

export interface PlexSettings {
  name: string;
  machineId?: string;
  ip: string;
  port: number;
  useSsl?: boolean;
  libraries: Library[];
  webAppUrl?: string;
}

export interface JellyfinSettings {
  name: string;
  ip: string;
  port: number;
  useSsl?: boolean;
  urlBase?: string;
  externalHostname?: string;
  jellyfinForgotPasswordUrl?: string;
  libraries: Library[];
  serverId: string;
  apiKey: string;
}
export interface TautulliSettings {
  hostname?: string;
  port?: number;
  useSsl?: boolean;
  urlBase?: string;
  apiKey?: string;
  externalUrl?: string;
}

export interface TraktSettings {
  provider?: 'direct' | 'jellyfin';
  clientId: string;
  clientSecret: string;
}

export interface AniListSettings {
  clientId: string;
  clientSecret: string;
}

/** Simkl PIN applications use a public client id only. */
export interface SimklSettings {
  clientId: string;
  showCommunityRating: boolean;
  posterCommunityRating: boolean;
}

export interface MediaActionsSettings {
  providers: {
    trakt: boolean;
    jellyfin: boolean;
    anilist: boolean;
    simkl: boolean;
  };
}

export interface ServarrInterventionSettings {
  automaticCleanupEnabled: boolean;
  cleanupGraceHours: number;
}

export interface MdbListSettings extends RatingBadgeSettings {
  apiKey: string;
}

export interface DVRSettings {
  id: number;
  name: string;
  hostname: string;
  port: number;
  apiKey: string;
  useSsl: boolean;
  baseUrl?: string;
  activeProfileId: number;
  activeProfileName: string;
  activeDirectory: string;
  tags: number[];
  is4k: boolean;
  isDefault: boolean;
  externalUrl?: string;
  syncEnabled: boolean;
  preventSearch: boolean;
  enableInstantRequests?: boolean;
  tagRequests: boolean;
  overrideRule: number[];
}

export interface RadarrSettings extends DVRSettings {
  minimumAvailability: string;
}

export interface SonarrSettings extends DVRSettings {
  seriesType: 'standard' | 'daily' | 'anime';
  animeSeriesType: 'standard' | 'daily' | 'anime';
  activeAnimeProfileId?: number;
  activeAnimeProfileName?: string;
  activeAnimeDirectory?: string;
  activeAnimeLanguageProfileId?: number;
  activeLanguageProfileId?: number;
  animeTags?: number[];
  enableSeasonFolders: boolean;
  monitorNewItems: 'all' | 'none';
}

interface Quota {
  quotaLimit?: number;
  quotaDays?: number;
}

export enum MetadataProviderType {
  TMDB = 'tmdb',
  TVDB = 'tvdb',
}

export interface MetadataSettings {
  tv: MetadataProviderType;
  anime: MetadataProviderType;
}

export interface ProxySettings {
  enabled: boolean;
  hostname: string;
  port: number;
  useSsl: boolean;
  user: string;
  password: string;
  bypassFilter: string;
  bypassLocalAddresses: boolean;
}

export interface MainSettings {
  apiKey: string;
  applicationTitle: string;
  applicationUrl: string;
  cacheImages: boolean;
  defaultPermissions: number;
  defaultQuotas: {
    movie: Quota;
    tv: Quota;
  };
  hideAvailable: boolean;
  hideBlocklisted: boolean;
  localLogin: boolean;
  mediaServerLogin: boolean;
  newPlexLogin: boolean;
  discoverRegion: string;
  streamingRegion: string;
  originalLanguage: string;
  blocklistRegion: string;
  blocklistLanguage: string;
  blocklistedTags: string;
  blocklistedTagsLimit: number;
  mediaServerType: number;
  partialRequestsEnabled: boolean;
  enableSpecialEpisodes: boolean;
  locale: string;
  youtubeUrl: string;
  versionCheck: boolean;
}

export interface ProxySettings {
  enabled: boolean;
  hostname: string;
  port: number;
  useSsl: boolean;
  user: string;
  password: string;
  bypassFilter: string;
  bypassLocalAddresses: boolean;
}

export interface DnsCacheSettings {
  enabled: boolean;
  forceMinTtl?: number;
  forceMaxTtl?: number;
}

export interface NetworkSettings {
  csrfProtection: boolean;
  forceIpv4First: boolean;
  trustProxy: boolean;
  proxy: ProxySettings;
  dnsCache: DnsCacheSettings;
  apiRequestTimeout: number;
}

interface PublicSettings {
  initialized: boolean;
}

interface FullPublicSettings extends PublicSettings {
  applicationTitle: string;
  applicationUrl: string;
  hideAvailable: boolean;
  hideBlocklisted: boolean;
  localLogin: boolean;
  mediaServerLogin: boolean;
  movie4kEnabled: boolean;
  series4kEnabled: boolean;
  movieInstantRequestEnabled: boolean;
  movie4kInstantRequestEnabled: boolean;
  seriesInstantRequestEnabled: boolean;
  series4kInstantRequestEnabled: boolean;
  discoverRegion: string;
  streamingRegion: string;
  originalLanguage: string;
  mediaServerType: number;
  jellyfinExternalHost?: string;
  jellyfinForgotPasswordUrl?: string;
  jellyfinServerName?: string;
  partialRequestsEnabled: boolean;
  episodeRequestsEnabled: boolean;
  enableSpecialEpisodes: boolean;
  cacheImages: boolean;
  vapidPublic: string;
  enablePushRegistration: boolean;
  locale: string;
  emailEnabled: boolean;
  userEmailRequired: boolean;
  newPlexLogin: boolean;
  youtubeUrl: string;
  versionCheck: boolean;
  plexClientIdentifier: string;
  traktConfigured: boolean;
  anilistConfigured: boolean;
  simklConfigured: boolean;
  mediaActionsTraktEnabled: boolean;
  mediaActionsJellyfinEnabled: boolean;
  mediaActionsAnilistEnabled: boolean;
  mediaActionsSimklEnabled: boolean;
  mdblistConfigured: boolean;
  ratingBadges: RatingBadgeSettings;
}

export interface NotificationAgentConfig {
  enabled: boolean;
  embedPoster: boolean;
  types?: number;
  options: Record<string, unknown>;
}
export interface NotificationAgentDiscord extends NotificationAgentConfig {
  options: {
    botUsername?: string;
    botAvatarUrl?: string;
    webhookUrl: string;
    webhookRoleId?: string;
    webhookThreadId?: string;
    enableMentions: boolean;
    locale: AvailableLocale;
    useUserLocale: boolean;
  };
}

export interface NotificationAgentSlack extends NotificationAgentConfig {
  options: {
    webhookUrl: string;
    locale: AvailableLocale;
  };
}

export interface NotificationAgentEmail extends NotificationAgentConfig {
  options: {
    userEmailRequired: boolean;
    emailFrom: string;
    smtpHost: string;
    smtpPort: number;
    secure: boolean;
    ignoreTls: boolean;
    requireTls: boolean;
    authUser?: string;
    authPass?: string;
    allowSelfSigned: boolean;
    senderName: string;
    usePublicLogo: boolean;
    pgpPrivateKey?: string;
    pgpPassword?: string;
  };
}

export interface NotificationAgentTelegram extends NotificationAgentConfig {
  options: {
    botUsername?: string;
    botAPI: string;
    chatId: string;
    messageThreadId: string;
    sendSilently: boolean;
  };
}

export interface NotificationAgentPushbullet extends NotificationAgentConfig {
  options: {
    accessToken: string;
    channelTag?: string;
  };
}

export interface NotificationAgentPushover extends NotificationAgentConfig {
  options: {
    accessToken: string;
    userToken: string;
    sound: string;
  };
}

export interface NotificationAgentWebhook extends NotificationAgentConfig {
  options: {
    webhookUrl: string;
    jsonPayload: string;
    authHeader?: string;
    customHeaders?: { key: string; value: string }[];
    supportVariables?: boolean;
  };
}

export interface NotificationAgentGotify extends NotificationAgentConfig {
  options: {
    url: string;
    token: string;
    priority: number;
    locale: AvailableLocale;
  };
}

export interface NotificationAgentNtfy extends NotificationAgentConfig {
  options: {
    url: string;
    topic: string;
    authMethodUsernamePassword?: boolean;
    username?: string;
    password?: string;
    authMethodToken?: boolean;
    token?: string;
    priority?: number;
    locale: AvailableLocale;
  };
}

export enum NotificationAgentKey {
  DISCORD = 'discord',
  EMAIL = 'email',
  GOTIFY = 'gotify',
  NTFY = 'ntfy',
  PUSHBULLET = 'pushbullet',
  PUSHOVER = 'pushover',
  SLACK = 'slack',
  TELEGRAM = 'telegram',
  WEBHOOK = 'webhook',
  WEBPUSH = 'webpush',
}

interface NotificationAgents {
  discord: NotificationAgentDiscord;
  email: NotificationAgentEmail;
  gotify: NotificationAgentGotify;
  ntfy: NotificationAgentNtfy;
  pushbullet: NotificationAgentPushbullet;
  pushover: NotificationAgentPushover;
  slack: NotificationAgentSlack;
  telegram: NotificationAgentTelegram;
  webhook: NotificationAgentWebhook;
  webpush: NotificationAgentConfig;
}

interface NotificationSettings {
  agents: NotificationAgents;
}

interface JobSettings {
  schedule: string;
}

export type JobId =
  | 'plex-recently-added-scan'
  | 'plex-full-scan'
  | 'plex-watchlist-sync'
  | 'plex-refresh-token'
  | 'radarr-scan'
  | 'sonarr-scan'
  | 'download-sync'
  | 'download-sync-reset'
  | 'jellyfin-recently-added-scan'
  | 'jellyfin-full-scan'
  | 'image-cache-cleanup'
  | 'availability-sync'
  | 'process-blocklisted-tags'
  | 'episode-request-sync'
  | 'release-calendar-sync'
  | 'mapping-pack-refresh'
  | 'mapping-backfill';

export interface AllSettings {
  clientId: string;
  sessionSecret?: string;
  vapidPublic: string;
  vapidPrivate: string;
  main: MainSettings;
  plex: PlexSettings;
  jellyfin: JellyfinSettings;
  tautulli: TautulliSettings;
  trakt: TraktSettings;
  anilist: AniListSettings;
  simkl: SimklSettings;
  mediaActions: MediaActionsSettings;
  servarrInterventions: ServarrInterventionSettings;
  mdblist: MdbListSettings;
  radarr: RadarrSettings[];
  sonarr: SonarrSettings[];
  public: PublicSettings;
  notifications: NotificationSettings;
  jobs: Record<JobId, JobSettings>;
  network: NetworkSettings;
  metadataSettings: MetadataSettings;
  migrations: string[];
}

const SETTINGS_PATH = process.env.CONFIG_DIRECTORY
  ? `${process.env.CONFIG_DIRECTORY}/settings.json`
  : path.join(__dirname, '../../../config/settings.json');

class Settings {
  private data: AllSettings;
  private saveLock: Promise<void> = Promise.resolve();

  constructor(initialSettings?: AllSettings) {
    this.data = {
      clientId: randomUUID(),
      sessionSecret: '',
      vapidPrivate: '',
      vapidPublic: '',
      main: {
        apiKey: '',
        applicationTitle: 'Foreseerr',
        applicationUrl: '',
        cacheImages: false,
        defaultPermissions: Permission.REQUEST,
        defaultQuotas: {
          movie: {},
          tv: {},
        },
        hideAvailable: false,
        hideBlocklisted: false,
        localLogin: true,
        mediaServerLogin: true,
        newPlexLogin: true,
        discoverRegion: '',
        streamingRegion: '',
        originalLanguage: '',
        blocklistRegion: '',
        blocklistLanguage: '',
        blocklistedTags: '',
        blocklistedTagsLimit: 50,
        mediaServerType: MediaServerType.NOT_CONFIGURED,
        partialRequestsEnabled: true,
        enableSpecialEpisodes: false,
        locale: 'en',
        youtubeUrl: '',
        versionCheck: true,
      },
      plex: {
        name: '',
        ip: '',
        port: 32400,
        useSsl: false,
        libraries: [],
      },
      jellyfin: {
        name: '',
        ip: '',
        port: 8096,
        useSsl: false,
        urlBase: '',
        externalHostname: '',
        jellyfinForgotPasswordUrl: '',
        libraries: [],
        serverId: '',
        apiKey: '',
      },
      tautulli: {},
      trakt: {
        clientId: '',
        clientSecret: '',
      },
      anilist: {
        clientId: '',
        clientSecret: '',
      },
      simkl: {
        clientId: '',
        showCommunityRating: true,
        posterCommunityRating: false,
      },
      mediaActions: {
        providers: {
          trakt: true,
          jellyfin: true,
          anilist: true,
          simkl: true,
        },
      },
      servarrInterventions: {
        automaticCleanupEnabled: false,
        cleanupGraceHours: 24,
      },
      mdblist: {
        apiKey: '',
        ...DEFAULT_RATING_BADGE_SETTINGS,
      },
      metadataSettings: {
        tv: MetadataProviderType.TMDB,
        anime: MetadataProviderType.TMDB,
      },
      radarr: [],
      sonarr: [],
      public: {
        initialized: false,
      },
      notifications: {
        agents: {
          email: {
            enabled: false,
            embedPoster: true,
            options: {
              userEmailRequired: false,
              emailFrom: '',
              smtpHost: '',
              smtpPort: 587,
              secure: false,
              ignoreTls: false,
              requireTls: false,
              allowSelfSigned: false,
              senderName: 'Foreseerr',
              usePublicLogo: false,
            },
          },
          discord: {
            enabled: false,
            embedPoster: true,
            types: 0,
            options: {
              webhookUrl: '',
              webhookRoleId: '',
              enableMentions: true,
              locale: 'en',
              useUserLocale: true,
            },
          },
          slack: {
            enabled: false,
            embedPoster: true,
            types: 0,
            options: {
              webhookUrl: '',
              locale: 'en',
            },
          },
          telegram: {
            enabled: false,
            embedPoster: true,
            types: 0,
            options: {
              botAPI: '',
              chatId: '',
              messageThreadId: '',
              sendSilently: false,
            },
          },
          pushbullet: {
            enabled: false,
            embedPoster: false,
            types: 0,
            options: {
              accessToken: '',
            },
          },
          pushover: {
            enabled: false,
            embedPoster: true,
            types: 0,
            options: {
              accessToken: '',
              userToken: '',
              sound: '',
            },
          },
          webhook: {
            enabled: false,
            embedPoster: true,
            types: 0,
            options: {
              webhookUrl: '',
              jsonPayload:
                'IntcbiAgXCJub3RpZmljYXRpb25fdHlwZVwiOiBcInt7bm90aWZpY2F0aW9uX3R5cGV9fVwiLFxuICBcImV2ZW50XCI6IFwie3tldmVudH19XCIsXG4gIFwic3ViamVjdFwiOiBcInt7c3ViamVjdH19XCIsXG4gIFwibWVzc2FnZVwiOiBcInt7bWVzc2FnZX19XCIsXG4gIFwiaW1hZ2VcIjogXCJ7e2ltYWdlfX1cIixcbiAgXCJ7e21lZGlhfX1cIjoge1xuICAgIFwibWVkaWFfdHlwZVwiOiBcInt7bWVkaWFfdHlwZX19XCIsXG4gICAgXCJ0bWRiSWRcIjogXCJ7e21lZGlhX3RtZGJpZH19XCIsXG4gICAgXCJ0dmRiSWRcIjogXCJ7e21lZGlhX3R2ZGJpZH19XCIsXG4gICAgXCJzdGF0dXNcIjogXCJ7e21lZGlhX3N0YXR1c319XCIsXG4gICAgXCJzdGF0dXM0a1wiOiBcInt7bWVkaWFfc3RhdHVzNGt9fVwiXG4gIH0sXG4gIFwie3tyZXF1ZXN0fX1cIjoge1xuICAgIFwicmVxdWVzdF9pZFwiOiBcInt7cmVxdWVzdF9pZH19XCIsXG4gICAgXCJyZXF1ZXN0ZWRCeV9lbWFpbFwiOiBcInt7cmVxdWVzdGVkQnlfZW1haWx9fVwiLFxuICAgIFwicmVxdWVzdGVkQnlfdXNlcm5hbWVcIjogXCJ7e3JlcXVlc3RlZEJ5X3VzZXJuYW1lfX1cIixcbiAgICBcInJlcXVlc3RlZEJ5X2F2YXRhclwiOiBcInt7cmVxdWVzdGVkQnlfYXZhdGFyfX1cIixcbiAgICBcInJlcXVlc3RlZEJ5X3NldHRpbmdzX2Rpc2NvcmRJZFwiOiBcInt7cmVxdWVzdGVkQnlfc2V0dGluZ3NfZGlzY29yZElkfX1cIixcbiAgICBcInJlcXVlc3RlZEJ5X3NldHRpbmdzX3RlbGVncmFtQ2hhdElkXCI6IFwie3tyZXF1ZXN0ZWRCeV9zZXR0aW5nc190ZWxlZ3JhbUNoYXRJZH19XCJcbiAgfSxcbiAgXCJ7e2lzc3VlfX1cIjoge1xuICAgIFwiaXNzdWVfaWRcIjogXCJ7e2lzc3VlX2lkfX1cIixcbiAgICBcImlzc3VlX3R5cGVcIjogXCJ7e2lzc3VlX3R5cGV9fVwiLFxuICAgIFwiaXNzdWVfc3RhdHVzXCI6IFwie3tpc3N1ZV9zdGF0dXN9fVwiLFxuICAgIFwicmVwb3J0ZWRCeV9lbWFpbFwiOiBcInt7cmVwb3J0ZWRCeV9lbWFpbH19XCIsXG4gICAgXCJyZXBvcnRlZEJ5X3VzZXJuYW1lXCI6IFwie3tyZXBvcnRlZEJ5X3VzZXJuYW1lfX1cIixcbiAgICBcInJlcG9ydGVkQnlfYXZhdGFyXCI6IFwie3tyZXBvcnRlZEJ5X2F2YXRhcn19XCIsXG4gICAgXCJyZXBvcnRlZEJ5X3NldHRpbmdzX2Rpc2NvcmRJZFwiOiBcInt7cmVwb3J0ZWRCeV9zZXR0aW5nc19kaXNjb3JkSWR9fVwiLFxuICAgIFwicmVwb3J0ZWRCeV9zZXR0aW5nc190ZWxlZ3JhbUNoYXRJZFwiOiBcInt7cmVwb3J0ZWRCeV9zZXR0aW5nc190ZWxlZ3JhbUNoYXRJZH19XCJcbiAgfSxcbiAgXCJ7e2NvbW1lbnR9fVwiOiB7XG4gICAgXCJjb21tZW50X21lc3NhZ2VcIjogXCJ7e2NvbW1lbnRfbWVzc2FnZX19XCIsXG4gICAgXCJjb21tZW50ZWRCeV9lbWFpbFwiOiBcInt7Y29tbWVudGVkQnlfZW1haWx9fVwiLFxuICAgIFwiY29tbWVudGVkQnlfdXNlcm5hbWVcIjogXCJ7e2NvbW1lbnRlZEJ5X3VzZXJuYW1lfX1cIixcbiAgICBcImNvbW1lbnRlZEJ5X2F2YXRhclwiOiBcInt7Y29tbWVudGVkQnlfYXZhdGFyfX1cIixcbiAgICBcImNvbW1lbnRlZEJ5X3NldHRpbmdzX2Rpc2NvcmRJZFwiOiBcInt7Y29tbWVudGVkQnlfc2V0dGluZ3NfZGlzY29yZElkfX1cIixcbiAgICBcImNvbW1lbnRlZEJ5X3NldHRpbmdzX3RlbGVncmFtQ2hhdElkXCI6IFwie3tjb21tZW50ZWRCeV9zZXR0aW5nc190ZWxlZ3JhbUNoYXRJZH19XCJcbiAgfSxcbiAgXCJ7e2V4dHJhfX1cIjogW11cbn0i',
            },
          },
          webpush: {
            enabled: false,
            embedPoster: true,
            options: {},
          },
          gotify: {
            enabled: false,
            embedPoster: false,
            types: 0,
            options: {
              url: '',
              token: '',
              priority: 0,
              locale: 'en',
            },
          },
          ntfy: {
            enabled: false,
            embedPoster: true,
            types: 0,
            options: {
              url: '',
              topic: '',
              priority: 3,
              locale: 'en',
            },
          },
        },
      },
      jobs: {
        'plex-recently-added-scan': {
          schedule: '0 */5 * * * *',
        },
        'plex-full-scan': {
          schedule: '0 0 3 * * *',
        },
        'plex-watchlist-sync': {
          schedule: '0 */3 * * * *',
        },
        'plex-refresh-token': {
          schedule: '0 0 5 * * *',
        },
        'radarr-scan': {
          schedule: '0 */15 * * * *',
        },
        'sonarr-scan': {
          schedule: '0 */15 * * * *',
        },
        'availability-sync': {
          schedule: '0 0 5 * * *',
        },
        'download-sync': {
          schedule: '0 * * * * *',
        },
        'download-sync-reset': {
          schedule: '0 0 1 * * *',
        },
        'jellyfin-recently-added-scan': {
          schedule: '0 */5 * * * *',
        },
        'jellyfin-full-scan': {
          schedule: '0 0 3 * * *',
        },
        'image-cache-cleanup': {
          schedule: '0 0 5 * * *',
        },
        'process-blocklisted-tags': {
          schedule: '0 30 1 */7 * *',
        },
        'episode-request-sync': {
          schedule: '0 */15 * * * *',
        },
        'release-calendar-sync': {
          schedule: '0 0 */6 * * *',
        },
        'mapping-pack-refresh': {
          schedule: '0 15 4 * * *',
        },
        'mapping-backfill': {
          schedule: '0 45 4 * * *',
        },
      },
      network: {
        csrfProtection: false,
        forceIpv4First: false,
        trustProxy: false,
        proxy: {
          enabled: false,
          hostname: '',
          port: 8080,
          useSsl: false,
          user: '',
          password: '',
          bypassFilter: '',
          bypassLocalAddresses: true,
        },
        dnsCache: {
          enabled: false,
          forceMinTtl: 0,
          forceMaxTtl: -1,
        },
        apiRequestTimeout: 60000,
      },
      migrations: [],
    };
    if (initialSettings) {
      this.data = mergeSettings(this.data, initialSettings);
    }
  }

  get main(): MainSettings {
    const applicationUrl = effectiveApplicationUrl(
      this.data.main.applicationUrl
    );
    if (applicationUrl === this.data.main.applicationUrl) {
      return this.data.main;
    }
    // Preserve normal mutable settings semantics while exposing the volatile
    // desktop origin only to runtime readers. `this.data` remains the durable
    // source used by save(), so a random loopback port cannot leak to disk.
    return new Proxy(this.data.main, {
      get: (target, property, receiver) =>
        property === 'applicationUrl'
          ? applicationUrl
          : Reflect.get(target, property, receiver),
      set: (target, property, value, receiver) => {
        // Settings route handlers may mutate `settings.main` directly. Keep
        // the visible ephemeral origin from becoming durable configuration
        // through that path as well as through the `main` setter below.
        if (
          property === 'applicationUrl' &&
          isManagedApplicationUrl(value, applicationUrl)
        ) {
          return true;
        }
        return Reflect.set(target, property, value, receiver);
      },
    });
  }

  set main(data: MainSettings) {
    if (
      isDesktopRuntime() &&
      isManagedApplicationUrl(
        data.applicationUrl,
        effectiveApplicationUrl(this.data.main.applicationUrl)
      )
    ) {
      data = { ...data, applicationUrl: this.data.main.applicationUrl };
    }
    this.data.main = mergeSettings(this.data.main, data);
  }

  get plex(): PlexSettings {
    return this.data.plex;
  }

  set plex(data: PlexSettings) {
    this.data.plex = mergeSettings(this.data.plex, data);
  }

  get jellyfin(): JellyfinSettings {
    return this.data.jellyfin;
  }

  set jellyfin(data: JellyfinSettings) {
    this.data.jellyfin = mergeSettings(this.data.jellyfin, data);
  }

  get tautulli(): TautulliSettings {
    return this.data.tautulli;
  }

  set tautulli(data: TautulliSettings) {
    this.data.tautulli = mergeSettings(this.data.tautulli, data);
  }

  get trakt(): TraktSettings {
    if (!this.data.trakt) {
      this.data.trakt = { provider: 'direct', clientId: '', clientSecret: '' };
    }
    return this.data.trakt;
  }

  set trakt(data: TraktSettings) {
    this.data.trakt = mergeSettings(
      this.data.trakt ?? { provider: 'direct', clientId: '', clientSecret: '' },
      { ...data, provider: data.provider ?? 'direct' }
    );
  }

  get anilist(): AniListSettings {
    if (!this.data.anilist) {
      this.data.anilist = { clientId: '', clientSecret: '' };
    }
    return this.data.anilist;
  }

  set anilist(data: AniListSettings) {
    this.data.anilist = mergeSettings(
      this.data.anilist ?? { clientId: '', clientSecret: '' },
      data
    );
  }

  get simkl(): SimklSettings {
    if (!this.data.simkl) {
      this.data.simkl = {
        clientId: '',
        showCommunityRating: true,
        posterCommunityRating: false,
      };
    }
    return this.data.simkl;
  }

  set simkl(data: SimklSettings) {
    this.data.simkl = mergeSettings(
      this.data.simkl ?? {
        clientId: '',
        showCommunityRating: true,
        posterCommunityRating: false,
      },
      data
    );
  }

  get mediaActions(): MediaActionsSettings {
    if (!this.data.mediaActions) {
      this.data.mediaActions = {
        providers: { trakt: true, jellyfin: true, anilist: true, simkl: true },
      };
    } else if (!this.data.mediaActions.providers) {
      this.data.mediaActions.providers = {
        trakt: true,
        jellyfin: true,
        anilist: true,
        simkl: true,
      };
    } else {
      if (this.data.mediaActions.providers.trakt === undefined) {
        this.data.mediaActions.providers.trakt = true;
      }
      if (this.data.mediaActions.providers.jellyfin === undefined) {
        this.data.mediaActions.providers.jellyfin = true;
      }
      if (this.data.mediaActions.providers.anilist === undefined) {
        this.data.mediaActions.providers.anilist = true;
      }
      if (this.data.mediaActions.providers.simkl === undefined) {
        this.data.mediaActions.providers.simkl = true;
      }
    }
    return this.data.mediaActions;
  }

  set mediaActions(data: MediaActionsSettings) {
    this.data.mediaActions = mergeSettings(
      this.data.mediaActions ?? {
        providers: { trakt: true, jellyfin: true, anilist: true, simkl: true },
      },
      data
    );
  }

  get servarrInterventions(): ServarrInterventionSettings {
    if (!this.data.servarrInterventions) {
      this.data.servarrInterventions = {
        automaticCleanupEnabled: false,
        cleanupGraceHours: 24,
      };
    }
    return this.data.servarrInterventions;
  }

  set servarrInterventions(data: ServarrInterventionSettings) {
    this.data.servarrInterventions = mergeSettings(
      this.servarrInterventions,
      data
    );
  }

  get mdblist(): MdbListSettings {
    if (!this.data.mdblist) {
      this.data.mdblist = {
        apiKey: '',
        ...DEFAULT_RATING_BADGE_SETTINGS,
      };
    } else {
      // Backfill newer poster-* keys for installs that predate them
      this.data.mdblist = {
        ...DEFAULT_RATING_BADGE_SETTINGS,
        ...this.data.mdblist,
      };
    }
    return this.data.mdblist;
  }

  set mdblist(data: MdbListSettings) {
    this.data.mdblist = mergeSettings(
      this.data.mdblist ?? {
        apiKey: '',
        ...DEFAULT_RATING_BADGE_SETTINGS,
      },
      data
    );
  }

  get metadataSettings(): MetadataSettings {
    return this.data.metadataSettings;
  }

  set metadataSettings(data: MetadataSettings) {
    this.data.metadataSettings = mergeSettings(
      this.data.metadataSettings,
      data
    );
  }

  get radarr(): RadarrSettings[] {
    return this.data.radarr;
  }

  set radarr(data: RadarrSettings[]) {
    this.data.radarr = data;
  }

  get sonarr(): SonarrSettings[] {
    return this.data.sonarr;
  }

  set sonarr(data: SonarrSettings[]) {
    this.data.sonarr = data;
  }

  get public(): PublicSettings {
    return this.data.public;
  }

  set public(data: PublicSettings) {
    this.data.public = mergeSettings(this.data.public, data);
  }

  get fullPublicSettings(): FullPublicSettings {
    return {
      ...this.data.public,
      applicationTitle: this.data.main.applicationTitle,
      applicationUrl: this.main.applicationUrl,
      hideAvailable: this.data.main.hideAvailable,
      hideBlocklisted: this.data.main.hideBlocklisted,
      localLogin: this.data.main.localLogin,
      mediaServerLogin: this.data.main.mediaServerLogin,
      jellyfinExternalHost: this.data.jellyfin.externalHostname,
      jellyfinForgotPasswordUrl: this.data.jellyfin.jellyfinForgotPasswordUrl,
      movie4kEnabled: this.data.radarr.some(
        (radarr) => radarr.is4k && radarr.isDefault
      ),
      series4kEnabled: this.data.sonarr.some(
        (sonarr) => sonarr.is4k && sonarr.isDefault
      ),
      movieInstantRequestEnabled: (() => {
        const server = this.data.radarr.find(
          (radarr) => !radarr.is4k && radarr.isDefault
        );
        return server != null && server.enableInstantRequests !== false;
      })(),
      movie4kInstantRequestEnabled: (() => {
        const server = this.data.radarr.find(
          (radarr) => radarr.is4k && radarr.isDefault
        );
        return server != null && server.enableInstantRequests !== false;
      })(),
      seriesInstantRequestEnabled: (() => {
        const server = this.data.sonarr.find(
          (sonarr) => !sonarr.is4k && sonarr.isDefault
        );
        return server != null && server.enableInstantRequests !== false;
      })(),
      series4kInstantRequestEnabled: (() => {
        const server = this.data.sonarr.find(
          (sonarr) => sonarr.is4k && sonarr.isDefault
        );
        return server != null && server.enableInstantRequests !== false;
      })(),
      discoverRegion: this.data.main.discoverRegion,
      streamingRegion: this.data.main.streamingRegion,
      originalLanguage: this.data.main.originalLanguage,
      mediaServerType: this.main.mediaServerType,
      partialRequestsEnabled: this.data.main.partialRequestsEnabled,
      episodeRequestsEnabled:
        this.data.main.partialRequestsEnabled &&
        this.data.metadataSettings.tv === MetadataProviderType.TVDB,
      enableSpecialEpisodes: this.data.main.enableSpecialEpisodes,
      cacheImages: this.data.main.cacheImages,
      vapidPublic: this.vapidPublic,
      enablePushRegistration: this.data.notifications.agents.webpush.enabled,
      locale: this.data.main.locale,
      emailEnabled: this.data.notifications.agents.email.enabled,
      userEmailRequired:
        this.data.notifications.agents.email.options.userEmailRequired,
      newPlexLogin: this.data.main.newPlexLogin,
      youtubeUrl: this.data.main.youtubeUrl,
      versionCheck: this.data.main.versionCheck,
      plexClientIdentifier: this.data.clientId,
      traktConfigured:
        this.trakt.provider === 'jellyfin'
          ? Boolean(this.data.jellyfin?.ip)
          : Boolean(this.data.trakt?.clientId && this.data.trakt?.clientSecret),
      anilistConfigured: Boolean(
        this.data.anilist?.clientId && this.data.anilist?.clientSecret
      ),
      simklConfigured: Boolean(this.data.simkl?.clientId?.trim()),
      mediaActionsTraktEnabled:
        this.data.mediaActions?.providers?.trakt !== false,
      mediaActionsJellyfinEnabled:
        this.data.mediaActions?.providers?.jellyfin !== false,
      mediaActionsAnilistEnabled:
        this.data.mediaActions?.providers?.anilist !== false,
      mediaActionsSimklEnabled:
        this.data.mediaActions?.providers?.simkl !== false,
      mdblistConfigured: Boolean(this.data.mdblist?.apiKey?.trim()),
      ratingBadges: {
        showTmdb:
          this.data.mdblist?.showTmdb ?? DEFAULT_RATING_BADGE_SETTINGS.showTmdb,
        showImdb:
          this.data.mdblist?.showImdb ?? DEFAULT_RATING_BADGE_SETTINGS.showImdb,
        showRt:
          this.data.mdblist?.showRt ?? DEFAULT_RATING_BADGE_SETTINGS.showRt,
        showRtUser:
          this.data.mdblist?.showRtUser ??
          DEFAULT_RATING_BADGE_SETTINGS.showRtUser,
        showMetacritic:
          this.data.mdblist?.showMetacritic ??
          DEFAULT_RATING_BADGE_SETTINGS.showMetacritic,
        showTraktCommunity:
          this.data.mdblist?.showTraktCommunity ??
          DEFAULT_RATING_BADGE_SETTINGS.showTraktCommunity,
        posterTmdb:
          this.data.mdblist?.posterTmdb ??
          DEFAULT_RATING_BADGE_SETTINGS.posterTmdb,
        posterImdb:
          this.data.mdblist?.posterImdb ??
          DEFAULT_RATING_BADGE_SETTINGS.posterImdb,
        posterRt:
          this.data.mdblist?.posterRt ?? DEFAULT_RATING_BADGE_SETTINGS.posterRt,
        posterRtUser:
          this.data.mdblist?.posterRtUser ??
          DEFAULT_RATING_BADGE_SETTINGS.posterRtUser,
        posterMetacritic:
          this.data.mdblist?.posterMetacritic ??
          DEFAULT_RATING_BADGE_SETTINGS.posterMetacritic,
        posterTraktCommunity:
          this.data.mdblist?.posterTraktCommunity ??
          DEFAULT_RATING_BADGE_SETTINGS.posterTraktCommunity,
      },
    };
  }

  get notifications(): NotificationSettings {
    return this.data.notifications;
  }

  set notifications(data: NotificationSettings) {
    this.data.notifications = mergeSettings(this.data.notifications, data);
  }

  get jobs(): Record<JobId, JobSettings> {
    return this.data.jobs;
  }

  set jobs(data: Record<JobId, JobSettings>) {
    this.data.jobs = mergeSettings(this.data.jobs, data);
  }

  get network(): NetworkSettings {
    return this.data.network;
  }

  set network(data: NetworkSettings) {
    this.data.network = mergeSettings(this.data.network, data);
  }

  get migrations(): string[] {
    return this.data.migrations;
  }

  set migrations(data: string[]) {
    this.data.migrations = data;
  }

  get clientId(): string {
    return this.data.clientId;
  }

  get sessionSecret(): string {
    return this.data.sessionSecret!;
  }

  get vapidPublic(): string {
    return this.data.vapidPublic;
  }

  get vapidPrivate(): string {
    return this.data.vapidPrivate;
  }

  public async regenerateApiKey(): Promise<MainSettings> {
    this.main.apiKey = this.generateApiKey();
    await this.save();
    return this.main;
  }

  private generateApiKey(): string {
    if (process.env.API_KEY) {
      return process.env.API_KEY;
    } else {
      return Buffer.from(`${Date.now()}${randomUUID()}`).toString('base64');
    }
  }

  /**
   * Settings Load
   *
   * This will load settings from file unless an optional argument of the object structure
   * is passed in.
   * @param overrideSettings If passed in, will override all existing settings with these
   * @param raw If true, will load the settings without running migrations or generating missing
   * values
   */
  public async load(
    overrideSettings?: AllSettings,
    raw = false
  ): Promise<Settings> {
    if (overrideSettings) {
      this.data = overrideSettings;
      return this;
    }

    let data;
    try {
      data = await fs.readFile(SETTINGS_PATH, 'utf-8');
    } catch {
      await this.save();
    }

    let change = false;
    if (data && !raw) {
      const parsedJson = JSON.parse(data);
      const migratedData = await runMigrations(parsedJson, SETTINGS_PATH);
      const merged = mergeSettings(this.data, migratedData);

      if (JSON.stringify(merged) !== JSON.stringify(migratedData)) {
        change = true;
      }

      this.data = merged;
    } else if (data) {
      this.data = JSON.parse(data);
    }

    // generate keys and ids if it's missing
    if (!this.data.main.apiKey) {
      this.data.main.apiKey = this.generateApiKey();
      change = true;
    } else if (process.env.API_KEY) {
      if (this.main.apiKey != process.env.API_KEY) {
        this.main.apiKey = process.env.API_KEY;
      }
    }
    if (!this.data.clientId) {
      this.data.clientId = randomUUID();
      change = true;
    }
    if (!this.data.sessionSecret) {
      this.data.sessionSecret = randomBytes(32).toString('hex');
      change = true;
    }
    if (!this.data.vapidPublic || !this.data.vapidPrivate) {
      const vapidKeys = webpush.generateVAPIDKeys();
      this.data.vapidPrivate = vapidKeys.privateKey;
      this.data.vapidPublic = vapidKeys.publicKey;
      change = true;
    }
    if (change) {
      await this.save();
    }

    return this;
  }

  public async save(): Promise<void> {
    const savePromise = this.saveLock.then(async () => {
      const tmp = SETTINGS_PATH + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(this.data, undefined, ' '));
      await fs.rename(tmp, SETTINGS_PATH);
    });

    this.saveLock = savePromise.catch(() => {
      // Keep the chain alive so future saves aren't blocked by past failures
    });

    return savePromise;
  }
}

let settings: Settings | undefined;

export const settingsFns = {
  getSettings(initialSettings?: AllSettings): Settings {
    if (!settings) {
      settings = new Settings(initialSettings);
    }

    return settings;
  },
};

export const getSettings = (initialSettings?: AllSettings): Settings =>
  settingsFns.getSettings(initialSettings);

export const resetSettings = (): void => {
  settings = undefined;
};

export default Settings;
