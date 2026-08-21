import type { AllSettings } from '@server/lib/settings';

type ArrScanMigrationSettings = Omit<
  Partial<AllSettings>,
  'jobs' | 'migrations'
> & {
  jobs?: Partial<Pick<AllSettings['jobs'], 'radarr-scan' | 'sonarr-scan'>>;
  migrations?: string[];
};

const MIGRATION = '0014_arr_scan_15m';
const EVERY_15M = '0 */15 * * * *';
const OLD_RADARR_DEFAULT = '0 0 4 * * *';
const OLD_SONARR_DEFAULT = '0 30 4 * * *';

/**
 * Daily 04:00 *arr scans leave imported movies on PROCESSING ("Requested")
 * until the next morning. Only rewrite the factory crons so an administrator
 * override stays intact.
 */
const migrateArrScanInterval = (
  settings: ArrScanMigrationSettings
): AllSettings => {
  if (
    Array.isArray(settings.migrations) &&
    settings.migrations.includes(MIGRATION)
  ) {
    return settings as AllSettings;
  }

  if (!settings.jobs) settings.jobs = {};

  if (
    !settings.jobs['radarr-scan'] ||
    settings.jobs['radarr-scan'].schedule === OLD_RADARR_DEFAULT
  ) {
    settings.jobs['radarr-scan'] = { schedule: EVERY_15M };
  }

  if (
    !settings.jobs['sonarr-scan'] ||
    settings.jobs['sonarr-scan'].schedule === OLD_SONARR_DEFAULT
  ) {
    settings.jobs['sonarr-scan'] = { schedule: EVERY_15M };
  }

  if (!Array.isArray(settings.migrations)) settings.migrations = [];
  settings.migrations.push(MIGRATION);
  return settings as AllSettings;
};

export default migrateArrScanInterval;
