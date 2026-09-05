import AnilistAPI, { AnilistAuthError } from '@server/api/anilist';
import { getRepository } from '@server/datasource';
import { UserSettings } from '@server/entity/UserSettings';
import { invalidateUserAnilistSyncCache } from '@server/lib/mediaActions/anilistSyncCache';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

export class AnilistNotConfiguredError extends Error {
  constructor(message = 'AniList application credentials are not configured') {
    super(message);
    this.name = 'AnilistNotConfiguredError';
  }
}

export class AnilistNotLinkedError extends Error {
  constructor(message = 'User has not linked an AniList account') {
    super(message);
    this.name = 'AnilistNotLinkedError';
  }
}

export class AnilistAccountAlreadyLinkedError extends Error {
  constructor(
    message = 'This AniList account is already linked to another Foreseerr user'
  ) {
    super(message);
    this.name = 'AnilistAccountAlreadyLinkedError';
  }
}

export function isAnilistUnavailableError(error: unknown): boolean {
  return (
    error instanceof AnilistNotConfiguredError ||
    error instanceof AnilistNotLinkedError
  );
}

export function anilistAvailabilityFromError(error: unknown): false {
  if (isAnilistUnavailableError(error)) {
    return false;
  }
  throw error;
}

export const anilistFns = {
  getAnilistAppCredentials(): {
    clientId: string;
    clientSecret: string;
  } {
    const { clientId, clientSecret } = getSettings().anilist;
    if (!clientId?.trim() || !clientSecret?.trim()) {
      throw new AnilistNotConfiguredError();
    }
    return {
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
    };
  },
  async getUserAnilistSettings(userId: number): Promise<UserSettings | null> {
    return getRepository(UserSettings)
      .createQueryBuilder('settings')
      .addSelect('settings.anilistAccessToken')
      .addSelect('settings.anilistTokenExpiresAt')
      .leftJoinAndSelect('settings.user', 'user')
      .where('user.id = :userId', { userId })
      .getOne();
  },
  async createAnilistUserClient(userId: number): Promise<AnilistAPI> {
    getAnilistAppCredentials();
    const settings = await getUserAnilistSettings(userId);
    const accessToken = settings?.anilistAccessToken?.trim();
    if (!settings || !accessToken) {
      throw new AnilistNotLinkedError();
    }
    if (isAnilistTokenExpired(settings.anilistTokenExpiresAt)) {
      logger.info('AniList token expired; clearing linked account', {
        label: 'AniList',
        userId,
      });
      await clearUserAnilistCredentials(settings.id, userId);
      throw new AnilistNotLinkedError(
        'AniList authorization expired; reconnect your account'
      );
    }
    return new AnilistAPI({ accessToken });
  },
};

export function getAnilistAppCredentials(): {
  clientId: string;
  clientSecret: string;
} {
  return anilistFns.getAnilistAppCredentials();
}

export function createAnilistAppClient(): AnilistAPI {
  getAnilistAppCredentials();
  return new AnilistAPI();
}

export async function getUserAnilistSettings(
  userId: number
): Promise<UserSettings | null> {
  return anilistFns.getUserAnilistSettings(userId);
}

export async function countLinkedAnilistAccounts(): Promise<number> {
  return getRepository(UserSettings)
    .createQueryBuilder('settings')
    .where('settings.anilistAccessToken IS NOT NULL')
    .getCount();
}

export async function assertAnilistAccountAvailable(
  anilistUserId: string,
  foreseerrUserId: number
): Promise<void> {
  const existing = await getRepository(UserSettings)
    .createQueryBuilder('settings')
    .leftJoin('settings.user', 'user')
    .where('settings.anilistUserId = :anilistUserId', { anilistUserId })
    .andWhere('user.id != :userId', { userId: foreseerrUserId })
    .getOne();

  if (existing) {
    throw new AnilistAccountAlreadyLinkedError();
  }
}

export function isAnilistTokenExpired(expiresAt?: string | null): boolean {
  if (!expiresAt) {
    return false;
  }
  const expires = Number(expiresAt);
  if (!Number.isFinite(expires) || expires <= 0) {
    return false;
  }
  return expires <= Math.floor(Date.now() / 1000) + 60;
}

export async function clearUserAnilistCredentials(
  settingsId: number,
  userId?: number
): Promise<void> {
  await getRepository(UserSettings)
    .createQueryBuilder()
    .update(UserSettings)
    .set({
      anilistAccessToken: () => 'NULL',
      anilistTokenExpiresAt: () => 'NULL',
      anilistUsername: () => 'NULL',
      anilistUserId: () => 'NULL',
    })
    .where('id = :id', { id: settingsId })
    .execute();

  if (userId != null) {
    invalidateUserAnilistSyncCache(userId);
  }
}

export async function disconnectAllAnilistLinks(): Promise<number> {
  const result = await getRepository(UserSettings)
    .createQueryBuilder()
    .update(UserSettings)
    .set({
      anilistAccessToken: () => 'NULL',
      anilistTokenExpiresAt: () => 'NULL',
      anilistUsername: () => 'NULL',
      anilistUserId: () => 'NULL',
    })
    .where('anilistAccessToken IS NOT NULL')
    .execute();
  return result.affected ?? 0;
}

export async function createAnilistUserClient(
  userId: number
): Promise<AnilistAPI> {
  return anilistFns.createAnilistUserClient(userId);
}

export { AnilistAuthError };
