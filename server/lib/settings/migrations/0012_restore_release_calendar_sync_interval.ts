import type { AllSettings } from '@server/lib/settings';

type ReleaseCalendarMigrationSettings = Omit<
  Partial<AllSettings>,
  'jobs' | 'migrations'
> & {
  jobs?: Partial<Pick<AllSettings['jobs'], 'release-calendar-sync'>>;
  migrations?: string[];
};

const MIGRATION = '0012_restore_release_calendar_sync_interval';
const COARSE_DEFAULT = '0 0 */6 * * *';

/**
 * H5: new installs use the restored six-hour default. Existing settings
 * cannot distinguish an administrator-selected five-minute schedule from the
 * value written by 0011, so this migration deliberately leaves all existing
 * schedules untouched rather than clobbering an explicit user choice.
 */
const restoreReleaseCalendarSyncInterval = (
  settings: ReleaseCalendarMigrationSettings
): AllSettings => {
  if (
    Array.isArray(settings.migrations) &&
    settings.migrations.includes(MIGRATION)
  ) {
    return settings as AllSettings;
  }

  if (!settings.jobs) settings.jobs = {};
  if (!settings.jobs['release-calendar-sync']) {
    settings.jobs['release-calendar-sync'] = { schedule: COARSE_DEFAULT };
  }

  if (!Array.isArray(settings.migrations)) settings.migrations = [];
  settings.migrations.push(MIGRATION);
  return settings as AllSettings;
};

export default restoreReleaseCalendarSyncInterval;
