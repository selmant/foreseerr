import type { AllSettings } from '@server/lib/settings';
import migrateHostname from '@server/lib/settings/migrations/0001_migrate_hostname';
import migrateApiTokens from '@server/lib/settings/migrations/0002_migrate_apitokens';
import migrateEmbyMediaServerType from '@server/lib/settings/migrations/0003_emby_media_server_type';
import migrateRegionSetting from '@server/lib/settings/migrations/0004_migrate_region_setting';
import migrateNetworkSettings from '@server/lib/settings/migrations/0005_migrate_network_settings';
import removeLunaSeaSetting from '@server/lib/settings/migrations/0006_remove_lunasea';
import migrationArrTags from '@server/lib/settings/migrations/0007_migrate_arr_tags';
import migrateBlacklistToBlocklist from '@server/lib/settings/migrations/0008_migrate_blacklist_to_blocklist';
import migrateReleaseCalendarSyncInterval from '@server/lib/settings/migrations/0011_release_calendar_sync_5m';
import restoreReleaseCalendarSyncInterval from '@server/lib/settings/migrations/0012_restore_release_calendar_sync_interval';
import increaseArrRequestTimeout from '@server/lib/settings/migrations/0013_increase_arr_request_timeout';
import migrateArrScanInterval from '@server/lib/settings/migrations/0014_arr_scan_15m';

export const SETTINGS_MIGRATIONS: {
  name: string;
  run: (settings: AllSettings) => AllSettings | Promise<AllSettings>;
}[] = [
  { name: '0001_migrate_hostname', run: migrateHostname },
  { name: '0002_migrate_apitokens', run: migrateApiTokens },
  { name: '0003_emby_media_server_type', run: migrateEmbyMediaServerType },
  { name: '0004_migrate_region_setting', run: migrateRegionSetting },
  { name: '0005_migrate_network_settings', run: migrateNetworkSettings },
  { name: '0006_remove_lunasea', run: removeLunaSeaSetting },
  { name: '0007_migrate_arr_tags', run: migrationArrTags },
  {
    name: '0008_migrate_blacklist_to_blocklist',
    run: migrateBlacklistToBlocklist,
  },
  {
    name: '0011_release_calendar_sync_5m',
    run: migrateReleaseCalendarSyncInterval,
  },
  {
    name: '0012_restore_release_calendar_sync_interval',
    run: restoreReleaseCalendarSyncInterval,
  },
  { name: '0013_increase_arr_request_timeout', run: increaseArrRequestTimeout },
  { name: '0014_arr_scan_15m', run: migrateArrScanInterval },
];
