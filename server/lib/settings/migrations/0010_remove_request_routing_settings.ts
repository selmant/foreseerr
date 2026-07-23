import type { AllSettings } from '@server/lib/settings';

const removeRequestRoutingSettings = (settings: any): AllSettings => {
  if (
    Array.isArray(settings.migrations) &&
    settings.migrations.includes('0010_remove_request_routing_settings')
  ) {
    return settings;
  }

  delete settings.requestRouting;
  delete settings.requestFilters;

  if (!Array.isArray(settings.migrations)) {
    settings.migrations = [];
  }
  settings.migrations.push('0010_remove_request_routing_settings');

  return settings as AllSettings;
};

export default removeRequestRoutingSettings;
