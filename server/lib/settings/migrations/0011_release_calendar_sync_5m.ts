import type { AllSettings } from '@server/lib/settings';

type ReleaseCalendarMigrationSettings = Omit<
  Partial<AllSettings>,
  'jobs' | 'migrations'
> & {
  jobs?: Partial<Pick<AllSettings['jobs'], 'release-calendar-sync'>>;
  migrations?: string[];
};

const MIGRATION = '0011_release_calendar_sync_5m';
const RESTORED_DEFAULT = '0 0 */6 * * *';

/**
 * Historical migration marker retained for compatibility. The five-minute
 * default was operationally unsafe; do not rewrite schedules here because a
 * persisted five-minute value may be an administrator's explicit choice.
 */
const migrateReleaseCalendarSyncInterval = (
  settings: ReleaseCalendarMigrationSettings
): AllSettings => {
  if (
    Array.isArray(settings.migrations) &&
    settings.migrations.includes(MIGRATION)
  ) {
    return settings as AllSettings;
  }

  if (!settings.jobs) {
    settings.jobs = {};
  }

  if (!settings.jobs['release-calendar-sync']) {
    settings.jobs['release-calendar-sync'] = { schedule: RESTORED_DEFAULT };
  }

  if (!Array.isArray(settings.migrations)) {
    settings.migrations = [];
  }
  settings.migrations.push(MIGRATION);

  return settings as AllSettings;
};

export default migrateReleaseCalendarSyncInterval;
