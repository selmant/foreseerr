import { buildJellyfinAuthorizationHeader } from '@server/api/jellyfin';
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
import { getHostname } from '@server/utils/getHostname';
import axios from 'axios';

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

export class TraktJellyfinProviderError extends Error {
  constructor(
    message = 'Better Trakt is not available for this Jellyfin user. Link Jellyfin, link Trakt in Better Trakt, and ask an administrator to enable Foreseer access.'
  ) {
    super(message);
    this.name = 'TraktJellyfinProviderError';
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

export const isJellyfinTraktProvider = (): boolean =>
  getSettings().trakt.provider === 'jellyfin';

type JellyfinTraktTokenResponse = {
  AccessToken?: unknown;
  AccessTokenExpiration?: unknown;
  ClientId?: unknown;
};

export type JellyfinTraktMeResponse = {
  IsLinked?: unknown;
  AllowExternalTokenAccess?: unknown;
};

export async function fetchJellyfinTraktJson<T>(
  user: Pick<User, 'jellyfinAuthToken' | 'jellyfinDeviceId'>,
  path: '/Trakt/me' | '/Trakt/me/Token',
  timeout: number
): Promise<T> {
  if (!user.jellyfinAuthToken || !user.jellyfinDeviceId) {
    throw new TraktJellyfinProviderError(
      'Link your Jellyfin account to Foreseer before using Better Trakt.'
    );
  }

  const response = await axios.get<T>(`${getHostname()}${path}`, {
    headers: {
      Authorization: buildJellyfinAuthorizationHeader(
        user.jellyfinAuthToken,
        user.jellyfinDeviceId
      ),
      Accept: 'application/json',
    },
    timeout,
  });
  return response.data;
}

async function getJellyfinTraktToken(
  userId: number
): Promise<TraktTokenState & { clientId: string }> {
  const user = await getRepository(User)
    .createQueryBuilder('user')
    .addSelect('user.jellyfinAuthToken')
    .addSelect('user.jellyfinDeviceId')
    .where('user.id = :userId', { userId })
    .getOne();

  if (
    !user?.jellyfinUserId ||
    !user.jellyfinAuthToken ||
    !user.jellyfinDeviceId
  ) {
    throw new TraktJellyfinProviderError(
      'Link your Jellyfin account to Foreseer before using Better Trakt.'
    );
  }

  try {
    const data = await fetchJellyfinTraktJson<JellyfinTraktTokenResponse>(
      user,
      '/Trakt/me/Token',
      10000
    );
    const accessToken =
      typeof data.AccessToken === 'string' ? data.AccessToken.trim() : '';
    const clientId =
      typeof data.ClientId === 'string' ? data.ClientId.trim() : '';
    const expiresAt = Math.floor(
      new Date(String(data.AccessTokenExpiration ?? '')).getTime() / 1000
    );

    if (!accessToken || !clientId || !Number.isFinite(expiresAt)) {
      throw new TraktJellyfinProviderError(
        'Better Trakt returned an incomplete token bridge response. Update Better Trakt and try again.'
      );
    }

    return {
      clientId,
      accessToken,
      // This sentinel makes TraktAPI call the provider callback before expiry;
      // no refresh token is persisted or transmitted by Foreseer.
      refreshToken: 'jellyfin-provider',
      expiresAt,
    };
  } catch (e) {
    if (e instanceof TraktJellyfinProviderError) {
      throw e;
    }
    const status = axios.isAxiosError(e) ? e.response?.status : undefined;
    if (status === 401 || status === 403) {
      throw new TraktJellyfinProviderError();
    }
    logger.warn('Failed to retrieve Better Trakt token bridge response', {
      label: 'Trakt API',
      userId,
      status,
      errorMessage: e instanceof Error ? e.message : 'unknown error',
    });
    throw new TraktJellyfinProviderError(
      'Unable to reach Better Trakt through Jellyfin. Check the Jellyfin connection and plugin setup.'
    );
  }
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
  if (isJellyfinTraktProvider()) {
    const token = await getJellyfinTraktToken(userId);
    return new TraktAPI({
      clientId: token.clientId,
      clientSecret: '',
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      refreshTokens: async () => {
        const refreshed = await getJellyfinTraktToken(userId);
        return refreshed;
      },
    });
  }

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
