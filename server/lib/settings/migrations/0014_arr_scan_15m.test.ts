import migrateArrScanInterval from '@server/lib/settings/migrations/0014_arr_scan_15m';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('0014_arr_scan_15m', () => {
  it('rewrites the factory daily Radarr/Sonarr crons', () => {
    const migrated = migrateArrScanInterval({
      jobs: {
        'radarr-scan': { schedule: '0 0 4 * * *' },
        'sonarr-scan': { schedule: '0 30 4 * * *' },
      },
      migrations: [],
    });

    assert.equal(migrated.jobs['radarr-scan'].schedule, '0 */15 * * * *');
    assert.equal(migrated.jobs['sonarr-scan'].schedule, '0 */15 * * * *');
    assert.ok(migrated.migrations.includes('0014_arr_scan_15m'));
  });

  it('leaves an administrator override intact', () => {
    const migrated = migrateArrScanInterval({
      jobs: {
        'radarr-scan': { schedule: '0 0 6 * * *' },
        'sonarr-scan': { schedule: '0 0 7 * * *' },
      },
      migrations: [],
    });

    assert.equal(migrated.jobs['radarr-scan'].schedule, '0 0 6 * * *');
    assert.equal(migrated.jobs['sonarr-scan'].schedule, '0 0 7 * * *');
  });

  it('is idempotent', () => {
    const once = migrateArrScanInterval({ jobs: {}, migrations: [] });
    const twice = migrateArrScanInterval(once);
    assert.equal(
      twice.migrations.filter((name) => name === '0014_arr_scan_15m').length,
      1
    );
  });
});
