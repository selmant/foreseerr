import type { AllSettings } from '@server/lib/settings';

// Retained as a migration ledger entry for settings.json files that already
// recorded it. The retired request-routing data is removed by migration 0010.
const recordLegacyRequestRoutingMigration = (settings: any): AllSettings => {
  if (!Array.isArray(settings.migrations)) {
    settings.migrations = [];
  }
  if (!settings.migrations.includes('0009_migrate_request_routing_settings')) {
    settings.migrations.push('0009_migrate_request_routing_settings');
  }
  return settings as AllSettings;
};

export default recordLegacyRequestRoutingMigration;
