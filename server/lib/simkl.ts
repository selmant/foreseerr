import SimklAPI, {
  SimklNotConfiguredError,
  SimklNotLinkedError,
} from '@server/api/simkl';
import { getRepository } from '@server/datasource';
import { SimklSyncItem } from '@server/entity/SimklSyncItem';
import { SimklSyncState } from '@server/entity/SimklSyncState';
import { UserSettings } from '@server/entity/UserSettings';
import { getSettings } from '@server/lib/settings';

export { SimklNotConfiguredError, SimklNotLinkedError };

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
    .where('settings.userId = :userId', { userId })
    .getOne();

export async function createSimklUserClient(userId: number): Promise<SimklAPI> {
  if (!getSettings().simkl.clientId.trim()) throw new SimklNotConfiguredError();
  const settings = await getUserSimklSettings(userId);
  if (!settings?.simklAccessToken) throw new SimklNotLinkedError();
  return new SimklAPI({
    accessToken: settings.simklAccessToken,
    onUnauthorized: async () => {
      await clearUserSimklCredentials(settings.id);
      await clearUserSimklSyncCache(userId);
    },
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
      simklUsername: () => 'NULL',
      simklUserId: () => 'NULL',
    })
    .where('simklUserId IS NOT NULL')
    .execute();
  await getRepository(SimklSyncItem).createQueryBuilder().delete().execute();
  await getRepository(SimklSyncState).createQueryBuilder().delete().execute();
  return linked;
}
