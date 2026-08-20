import JellyfinAPI from '@server/api/jellyfin';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { getHostname } from '@server/utils/getHostname';
import { asAllSettings, type MigrationSettings } from './types';

const migrateApiTokens = async (settings: MigrationSettings) => {
  const mediaServerType = settings.main.mediaServerType;
  if (
    !settings.jellyfin?.apiKey &&
    (mediaServerType === MediaServerType.JELLYFIN ||
      mediaServerType === MediaServerType.EMBY)
  ) {
    const userRepository = getRepository(User);
    const admin = await userRepository.findOne({
      where: { id: 1 },
      select: ['id', 'jellyfinAuthToken', 'jellyfinUserId', 'jellyfinDeviceId'],
      order: { id: 'ASC' },
    });
    if (!admin) {
      return asAllSettings(settings);
    }
    const jellyfinClient = new JellyfinAPI(
      getHostname(settings.jellyfin),
      admin.jellyfinAuthToken,
      admin.jellyfinDeviceId
    );
    jellyfinClient.setUserId(admin.jellyfinUserId ?? '');
    try {
      const apiKey = await jellyfinClient.createApiToken('Foreseerr');
      settings.jellyfin.apiKey = apiKey;
    } catch {
      throw new Error(
        "Failed to create Jellyfin API token from admin account. Please check your network configuration or edit your settings.json by adding an 'apiKey' field inside of the 'jellyfin' section to fix this issue."
      );
    }
  }
  return asAllSettings(settings);
};

export default migrateApiTokens;
