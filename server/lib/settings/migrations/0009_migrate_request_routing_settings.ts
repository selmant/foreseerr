import {
  DEFAULT_PROFILE_ROUTING,
  normalizeProfileRouting,
} from '@server/lib/requestFilters/types';
import type { AllSettings } from '@server/lib/settings';

type LegacyRequestFilters = {
  profileRouting?: unknown;
  animeSonarrServerId?: number | null;
  animeSonarrServerId4k?: number | null;
};

const migrateRequestRoutingSettings = (settings: any): AllSettings => {
  if (
    Array.isArray(settings.migrations) &&
    settings.migrations.includes('0009_migrate_request_routing_settings')
  ) {
    return settings;
  }

  const legacy: LegacyRequestFilters | undefined =
    settings.requestFilters ?? settings.requestRouting;

  if (legacy) {
    const profileRouting = normalizeProfileRouting(
      legacy.profileRouting as Parameters<typeof normalizeProfileRouting>[0]
    );

    if (profileRouting.animeTv.serverId == null) {
      const legacyAnimeServerId =
        legacy.animeSonarrServerId ?? legacy.animeSonarrServerId4k ?? null;
      if (legacyAnimeServerId != null) {
        profileRouting.animeTv = {
          ...profileRouting.animeTv,
          serverId: legacyAnimeServerId,
        };
      }
    }

    settings.requestRouting = { profileRouting };
    delete settings.requestFilters;
  } else {
    settings.requestRouting = {
      profileRouting: { ...DEFAULT_PROFILE_ROUTING },
    };
  }

  if (!Array.isArray(settings.migrations)) {
    settings.migrations = [];
  }
  settings.migrations.push('0009_migrate_request_routing_settings');

  return settings;
};

export default migrateRequestRoutingSettings;
