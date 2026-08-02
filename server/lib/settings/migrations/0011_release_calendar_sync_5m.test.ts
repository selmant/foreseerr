import migrateReleaseCalendarSyncInterval from '@server/lib/settings/migrations/0011_release_calendar_sync_5m';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('0011_release_calendar_sync_5m', () => {
  it('rewrites the previous 6-hour default to every 5 minutes', () => {
    const settings = migrateReleaseCalendarSyncInterval({
      jobs: { 'release-calendar-sync': { schedule: '0 0 */6 * * *' } },
      migrations: [],
    });

    assert.equal(
      settings.jobs['release-calendar-sync'].schedule,
      '0 */5 * * * *'
    );
    assert.ok(settings.migrations.includes('0011_release_calendar_sync_5m'));
  });

  it('preserves a customized schedule', () => {
    const settings = migrateReleaseCalendarSyncInterval({
      jobs: { 'release-calendar-sync': { schedule: '0 */15 * * * *' } },
      migrations: [],
    });

    assert.equal(
      settings.jobs['release-calendar-sync'].schedule,
      '0 */15 * * * *'
    );
    assert.ok(settings.migrations.includes('0011_release_calendar_sync_5m'));
  });

  it('is idempotent once recorded', () => {
    const settings = migrateReleaseCalendarSyncInterval({
      jobs: { 'release-calendar-sync': { schedule: '0 0 */6 * * *' } },
      migrations: ['0011_release_calendar_sync_5m'],
    });

    assert.equal(
      settings.jobs['release-calendar-sync'].schedule,
      '0 0 */6 * * *'
    );
  });
});
