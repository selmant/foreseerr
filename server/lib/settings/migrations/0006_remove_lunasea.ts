import { asAllSettings, type MigrationSettings } from './types';

const removeLunaSeaSetting = (settings: MigrationSettings) => {
  if (
    settings.notifications &&
    settings.notifications.agents &&
    settings.notifications.agents.lunasea
  ) {
    delete settings.notifications.agents.lunasea;
  }
  return asAllSettings(settings);
};

export default removeLunaSeaSetting;
