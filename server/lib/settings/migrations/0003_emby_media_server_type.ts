import { MediaServerType } from '@server/constants/server';
import { asAllSettings, type MigrationSettings } from './types';

const migrateHostname = (settings: MigrationSettings) => {
  const oldMediaServerType = settings.main.mediaServerType;
  if (
    oldMediaServerType === MediaServerType.JELLYFIN &&
    process.env.JELLYFIN_TYPE === 'emby'
  ) {
    settings.main.mediaServerType = MediaServerType.EMBY;
  }

  return asAllSettings(settings);
};

export default migrateHostname;
