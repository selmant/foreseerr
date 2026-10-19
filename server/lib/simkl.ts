import SimklAPI, {
  SimklNotConfiguredError,
  SimklNotLinkedError,
  SimklOAuthError,
  SimklUnauthorizedError,
  type SimklTokenState,
} from '@server/api/simkl';
import type { SimklOAuthTokenResponse } from '@server/api/simkl/interfaces';
import { getRepository } from '@server/datasource';
import { SimklSyncItem } from '@server/entity/SimklSyncItem';
import { SimklSyncState } from '@server/entity/SimklSyncState';
import { UserSettings } from '@server/entity/UserSettings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import AsyncLock from '@server/utils/asyncLock';

export { SimklNotConfiguredError, SimklNotLinkedError };

const simklRefreshLock = new AsyncLock();

export class SimklAccountAlreadyLinkedError extends Error {
  constructor() {
    super('This Simkl account is already linked to another Foreseerr user');
    this.name = 'SimklAccountAlreadyLinkedError';
  }
}

export const getUserSimklSettings = (userId: number) =>
  getRepository(UserSettings)
    .createQueryBuilder('settings')
    .addSelect('settings.simklAccessToken')
    .addSelect('settings.simklRefreshToken')
    .addSelect('settings.simklTokenExpiresAt')
    .where('settings.userId = :userId', { userId })
    .getOne();

/** Token columns for a fresh link; V1 links clear any V2 leftovers. */
export const simklTokenColumns = (
  tokens: Pick<SimklOAuthTokenResponse, 'access_token'> &
    Partial<SimklOAuthTokenResponse>
): Pick<
  UserSettings,
  'simklAccessToken' | 'simklRefreshToken' | 'simklTokenExpiresAt'
> => ({
  simklAccessToken: tokens.access_token,
  simklRefreshToken: tokens.refresh_token ?? null,
  simklTokenExpiresAt:
    tokens.refresh_token && tokens.expires_in
      ? String(Math.floor(Date.now() / 1000) + tokens.expires_in)
      : null,
});

export async function createSimklUserClient(userId: number): Promise<SimklAPI> {
  if (!getSettings().simkl.clientId.trim()) throw new SimklNotConfiguredError();
  const settings = await getUserSimklSettings(userId);
  if (!settings?.simklAccessToken) throw new SimklNotLinkedError();
  return new SimklAPI({
    accessToken: settings.simklAccessToken,
    tokenExpiresAt: settings.simklTokenExpiresAt
      ? Number(settings.simklTokenExpiresAt)
      : undefined,
    refreshTokens: settings.simklRefreshToken
      ? (stale) => refreshUserSimklTokens(userId, stale)
      : undefined,
    onUnauthorized: async () => {
      await clearUserSimklCredentials(settings.id);
      await clearUserSimklSyncCache(userId);
    },
  });
}

/**
 * Refresh one user's AUTH V2 access token exactly once. A refresh kills the
 * grant's previous access token, so concurrent callers must not each refresh:
 * whoever queued behind a refresh reuses the token it stored.
 */
export async function refreshUserSimklTokens(
  userId: number,
  staleAccessToken: string
): Promise<SimklTokenState> {
  return simklRefreshLock.dispatch(userId, async () => {
    const settings = await getUserSimklSettings(userId);
    if (!settings?.simklAccessToken || !settings.simklRefreshToken)
      throw new SimklUnauthorizedError();
    const expiresAt = settings.simklTokenExpiresAt
      ? Number(settings.simklTokenExpiresAt)
      : undefined;
    if (settings.simklAccessToken !== staleAccessToken)
      return { accessToken: settings.simklAccessToken, expiresAt };

    let tokens: SimklOAuthTokenResponse;
    try {
      tokens = await new SimklAPI().refreshAccessToken(
        settings.simklRefreshToken
      );
    } catch (e) {
      // `invalid_grant`: revoked, or idle past its 180 days. `invalid_client`:
      // the app itself is gone. Either way only a new link helps.
      if (
        e instanceof SimklOAuthError &&
        (e.code === 'invalid_grant' || e.code === 'invalid_client')
      ) {
        logger.warn('Simkl refresh token rejected; account must reconnect', {
          label: 'Simkl API',
          userId,
          error: e.code,
        });
        await clearUserSimklCredentials(settings.id);
        await clearUserSimklSyncCache(userId);
        throw new SimklUnauthorizedError();
      }
      throw e;
    }

    const columns = simklTokenColumns({
      ...tokens,
      // Non-rotating, but keep ours should a response ever omit it.
      refresh_token: tokens.refresh_token ?? settings.simklRefreshToken,
    });
    await getRepository(UserSettings).update(settings.id, columns);
    return {
      accessToken: tokens.access_token,
      expiresAt: columns.simklTokenExpiresAt
        ? Number(columns.simklTokenExpiresAt)
        : undefined,
    };
  });
}

export async function assertSimklAccountAvailable(
  simklUserId: string,
  userId: number
): Promise<void> {
  const existing = await getRepository(UserSettings)
    .createQueryBuilder('settings')
    .select('settings.userId', 'userId')
    .where('settings.simklUserId = :simklUserId', { simklUserId })
    .getRawOne<{ userId: number }>();
  if (existing && Number(existing.userId) !== userId)
    throw new SimklAccountAlreadyLinkedError();
}

export const countLinkedSimklAccounts = () =>
  getRepository(UserSettings)
    .createQueryBuilder('settings')
    .where('settings.simklUserId IS NOT NULL')
    .getCount();

export async function clearUserSimklCredentials(
  settingsId: number
): Promise<void> {
  await getRepository(UserSettings).update(settingsId, {
    simklAccessToken: () => 'NULL',
    simklRefreshToken: () => 'NULL',
    simklTokenExpiresAt: () => 'NULL',
    simklUsername: () => 'NULL',
    simklUserId: () => 'NULL',
  });
}

export async function clearUserSimklSyncCache(userId: number): Promise<void> {
  await getRepository(SimklSyncItem).delete({ user: { id: userId } });
  await getRepository(SimklSyncState).delete({ user: { id: userId } });
}

export async function disconnectAllSimklLinks(): Promise<number> {
  const repository = getRepository(UserSettings);
  const linked = await repository
    .createQueryBuilder('settings')
    .where('settings.simklUserId IS NOT NULL')
    .getCount();
  await repository
    .createQueryBuilder()
    .update()
    .set({
      simklAccessToken: () => 'NULL',
      simklRefreshToken: () => 'NULL',
      simklTokenExpiresAt: () => 'NULL',
      simklUsername: () => 'NULL',
      simklUserId: () => 'NULL',
    })
    .where('simklUserId IS NOT NULL')
    .execute();
  await getRepository(SimklSyncItem).createQueryBuilder().delete().execute();
  await getRepository(SimklSyncState).createQueryBuilder().delete().execute();
  return linked;
}
