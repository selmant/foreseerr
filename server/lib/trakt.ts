import TraktAPI, {
  TraktReconnectRequiredError,
  TraktRefreshRejectedError,
} from '@server/api/trakt';
import type { TraktTokenState } from '@server/api/trakt/interfaces';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { invalidateUserSyncCache } from '@server/lib/mediaActions/syncCache';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import AsyncLock from '@server/utils/asyncLock';

const traktRefreshLock = new AsyncLock();

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

export class TraktAccountAlreadyLinkedError extends Error {
  constructor(
    message = 'This Trakt account is already linked to another Foreseerr user'
  ) {
    super(message);
    this.name = 'TraktAccountAlreadyLinkedError';
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

export async function countLinkedTraktAccounts(): Promise<number> {
  return getRepository(UserSettings)
    .createQueryBuilder('settings')
    .where('settings.traktAccessToken IS NOT NULL')
    .andWhere('settings.traktRefreshToken IS NOT NULL')
    .getCount();
}

export async function assertTraktAccountAvailable(
  traktUserId: string,
  foreseerrUserId: number
): Promise<void> {
  const existing = await getRepository(UserSettings)
    .createQueryBuilder('settings')
    .leftJoin('settings.user', 'user')
    .where('settings.traktUserId = :traktUserId', { traktUserId })
    .andWhere('user.id != :userId', { userId: foreseerrUserId })
    .getOne();

  if (existing) {
    throw new TraktAccountAlreadyLinkedError();
  }
}

function tokenStateFromSettings(
  settings: UserSettings
): TraktTokenState | null {
  if (!settings.traktAccessToken || !settings.traktRefreshToken) {
    return null;
  }

  return {
    accessToken: settings.traktAccessToken,
    refreshToken: settings.traktRefreshToken,
    expiresAt: settings.traktTokenExpiresAt
      ? Number(settings.traktTokenExpiresAt)
      : 0,
  };
}

export async function clearUserTraktCredentials(
  settingsId: number,
  userId?: number
): Promise<void> {
  await getRepository(UserSettings)
    .createQueryBuilder()
    .update(UserSettings)
    .set({
      traktAccessToken: () => 'NULL',
      traktRefreshToken: () => 'NULL',
      traktTokenExpiresAt: () => 'NULL',
      traktUsername: () => 'NULL',
      traktUserId: () => 'NULL',
    })
    .where('id = :id', { id: settingsId })
    .execute();

  if (userId != null) {
    invalidateUserSyncCache(userId);
  }
}

export async function disconnectAllTraktLinks(): Promise<number> {
  const linked = await getRepository(UserSettings)
    .createQueryBuilder('settings')
    .leftJoinAndSelect('settings.user', 'user')
    .addSelect('settings.traktAccessToken')
    .where('settings.traktAccessToken IS NOT NULL')
    .andWhere('settings.traktRefreshToken IS NOT NULL')
    .getMany();

  if (!linked.length) {
    return 0;
  }

  await getRepository(UserSettings)
    .createQueryBuilder()
    .update(UserSettings)
    .set({
      traktAccessToken: () => 'NULL',
      traktRefreshToken: () => 'NULL',
      traktTokenExpiresAt: () => 'NULL',
      traktUsername: () => 'NULL',
      traktUserId: () => 'NULL',
    })
    .where('traktAccessToken IS NOT NULL')
    .andWhere('traktRefreshToken IS NOT NULL')
    .execute();

  for (const settings of linked) {
    if (settings.user?.id != null) {
      invalidateUserSyncCache(settings.user.id);
    }
  }

  return linked.length;
}

/**
 * Refresh one user's rotating Trakt credentials exactly once. Callers that
 * queued behind a successful refresh reuse the newly persisted token pair.
 */
export async function refreshUserTraktTokens(
  userId: number,
  callerTokens: TraktTokenState
): Promise<TraktTokenState> {
  return traktRefreshLock.dispatch(userId, async () => {
    const latestSettings = await getUserTraktSettings(userId);
    const latestTokens = latestSettings
      ? tokenStateFromSettings(latestSettings)
      : null;

    if (!latestSettings || !latestTokens) {
      throw new TraktReconnectRequiredError();
    }

    if (
      latestTokens.accessToken !== callerTokens.accessToken ||
      latestTokens.refreshToken !== callerTokens.refreshToken
    ) {
      return latestTokens;
    }

    const { clientId, clientSecret } = getTraktAppCredentials();
    const refreshClient = new TraktAPI({
      clientId,
      clientSecret,
      accessToken: latestTokens.accessToken,
      refreshToken: latestTokens.refreshToken,
      expiresAt: latestTokens.expiresAt,
    });

    let refreshedTokens: TraktTokenState;
    try {
      refreshedTokens = await refreshClient.refreshAccessToken();
    } catch (e) {
      if (e instanceof TraktRefreshRejectedError) {
        logger.warn('Trakt refresh token rejected; account must reconnect', {
          label: 'Trakt API',
          userId,
          status: e.status,
        });
        await clearUserTraktCredentials(latestSettings.id, userId);
        throw new TraktReconnectRequiredError();
      }
      throw e;
    }

    latestSettings.traktAccessToken = refreshedTokens.accessToken;
    latestSettings.traktRefreshToken = refreshedTokens.refreshToken;
    latestSettings.traktTokenExpiresAt = String(refreshedTokens.expiresAt);

    if (!latestSettings.traktUserId) {
      try {
        const profile = await refreshClient.getUserSettings();
        latestSettings.traktUserId = profile.traktUserId;
        latestSettings.traktUsername = profile.username;
      } catch (e) {
        logger.warn('Failed to backfill Trakt user identity during refresh', {
          label: 'Trakt API',
          userId,
          errorMessage: e instanceof Error ? e.message : 'unknown error',
        });
      }
    }

    await getRepository(UserSettings).save(latestSettings);

    return refreshedTokens;
  });
}

export async function createTraktUserClient(userId: number): Promise<TraktAPI> {
  const { clientId, clientSecret } = getTraktAppCredentials();
  const settings = await getUserTraktSettings(userId);

  if (!settings?.traktAccessToken || !settings.traktRefreshToken) {
    throw new TraktNotLinkedError();
  }

  return new TraktAPI({
    clientId,
    clientSecret,
    accessToken: settings.traktAccessToken,
    refreshToken: settings.traktRefreshToken,
    expiresAt: settings.traktTokenExpiresAt
      ? Number(settings.traktTokenExpiresAt)
      : undefined,
    refreshTokens: (tokens) => refreshUserTraktTokens(userId, tokens),
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
