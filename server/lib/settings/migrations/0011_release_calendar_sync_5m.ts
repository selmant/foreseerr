import type { AllSettings } from '@server/lib/settings';

const MIGRATION = '0011_release_calendar_sync_5m';
const PREVIOUS_DEFAULT = '0 0 */6 * * *';
const NEW_DEFAULT = '0 */5 * * * *';

/**
 * Bump Release Calendar Sync from the original 6-hour default to every
 * 5 minutes. Only rewrite installs that still use the previous default so
 * admin-customized schedules are preserved.
 */
const migrateReleaseCalendarSyncInterval = (settings: any): AllSettings => {
  if (
    Array.isArray(settings.migrations) &&
    settings.migrations.includes(MIGRATION)
  ) {
    return settings;
  }

  if (!settings.jobs) {
    settings.jobs = {};
  }

  const job = settings.jobs['release-calendar-sync'];
  if (!job || job.schedule === PREVIOUS_DEFAULT) {
    settings.jobs['release-calendar-sync'] = { schedule: NEW_DEFAULT };
  }

  if (!Array.isArray(settings.migrations)) {
    settings.migrations = [];
  }
  settings.migrations.push(MIGRATION);

  return settings;
};

export default migrateReleaseCalendarSyncInterval;
