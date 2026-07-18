import TraktAPI from '@server/api/trakt';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { getSettings } from '@server/lib/settings';

export class TraktNotConfiguredError extends Error {
  constructor(message = 'Trakt application credentials are not configured') {
    super(message);
    this.name = 'TraktNotConfiguredError';
  }
}

export class TraktNotLinkedError extends Error {
  constructor(message = 'User has not linked a Trakt account') {
    super(message);
    this.name = 'TraktNotLinkedError';
  }
}

export function getTraktAppCredentials(): {
  clientId: string;
  clientSecret: string;
} {
  const { clientId, clientSecret } = getSettings().trakt;
  if (!clientId?.trim() || !clientSecret?.trim()) {
    throw new TraktNotConfiguredError();
  }
  return {
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
  };
}

export function createTraktAppClient(): TraktAPI {
  const { clientId, clientSecret } = getTraktAppCredentials();
  return new TraktAPI({ clientId, clientSecret });
}

export async function getUserTraktSettings(
  userId: number
): Promise<UserSettings | null> {
  const settingsRepository = getRepository(UserSettings);
  return settingsRepository
    .createQueryBuilder('settings')
    .addSelect('settings.traktAccessToken')
    .addSelect('settings.traktRefreshToken')
    .addSelect('settings.traktTokenExpiresAt')
    .leftJoinAndSelect('settings.user', 'user')
    .where('user.id = :userId', { userId })
    .getOne();
}

export async function createTraktUserClient(userId: number): Promise<TraktAPI> {
  const { clientId, clientSecret } = getTraktAppCredentials();
  const settings = await getUserTraktSettings(userId);

  if (!settings?.traktAccessToken || !settings.traktRefreshToken) {
    throw new TraktNotLinkedError();
  }

  const settingsRepository = getRepository(UserSettings);

  return new TraktAPI({
    clientId,
    clientSecret,
    accessToken: settings.traktAccessToken,
    refreshToken: settings.traktRefreshToken,
    expiresAt: settings.traktTokenExpiresAt
      ? Number(settings.traktTokenExpiresAt)
      : undefined,
    onTokenRefresh: async ({ accessToken, refreshToken, expiresAt }) => {
      settings.traktAccessToken = accessToken;
      settings.traktRefreshToken = refreshToken;
      settings.traktTokenExpiresAt = String(expiresAt);
      await settingsRepository.save(settings);
    },
  });
}

export async function ensureUserSettings(
  userId: number
): Promise<UserSettings> {
  const userRepository = getRepository(User);
  const user = await userRepository.findOne({
    where: { id: userId },
    relations: { settings: true },
  });

  if (!user) {
    throw new Error('User not found');
  }

  if (!user.settings) {
    user.settings = new UserSettings({ user });
    await userRepository.save(user);
  }

  const settings = await getUserTraktSettings(userId);
  if (!settings) {
    throw new Error('User settings not found');
  }
  return settings;
}
