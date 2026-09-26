import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import type { Library } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { configDirectory } from '@server/utils/runtimePaths';
import { readFile } from 'fs/promises';
import path from 'path';
import { isPluginMode } from './pluginMode';

export interface JellyfinHostLibrary {
  id: string;
  name: string;
  enabled?: boolean;
  type: 'show' | 'movie';
}

export interface JellyfinHostAdminUser {
  jellyfinUserId: string;
  jellyfinUsername: string;
  email?: string;
}

export interface JellyfinHostFile {
  main?: {
    applicationUrl?: string;
    locale?: string;
    mediaServerLogin?: boolean;
    localLogin?: boolean;
  };
  jellyfin?: {
    name?: string;
    ip?: string;
    port?: number;
    useSsl?: boolean;
    urlBase?: string;
    externalHostname?: string;
    serverId?: string;
    apiKey?: string;
    /** null when the plugin could not list them. */
    libraries?: JellyfinHostLibrary[] | null;
  };
  /** Present when the Better Trakt plugin is loaded. */
  trakt?: {
    provider?: 'direct' | 'jellyfin';
  };
  adminUser?: JellyfinHostAdminUser;
}

/**
 * Plugin users are found by Jellyfin id; the unique email column only needs
 * a free label. A renamed or recreated Jellyfin account can reuse a name.
 */
export async function availablePluginEmail(
  username: string,
  jellyfinUserId: string
): Promise<string> {
  const name = username.toLowerCase();
  const candidates = [name, `${name}+${jellyfinUserId.slice(0, 8)}`];
  for (const email of candidates) {
    if ((await getRepository(User).count({ where: { email } })) === 0) {
      return email;
    }
  }
  return `${name}+${jellyfinUserId}`;
}

/**
 * Jellyfin administrators get ADMIN. Losing that in Jellyfin removes only an
 * ADMIN the plugin granted; one granted in Foreseerr stays.
 */
export function pluginAdminPermissions(
  current: number,
  isAdministrator: boolean,
  grantedByPlugin: boolean,
  defaults: number
): { permissions: number; grantedByPlugin: boolean } {
  if (isAdministrator) {
    return current & Permission.ADMIN
      ? { permissions: current, grantedByPlugin }
      : { permissions: current | Permission.ADMIN, grantedByPlugin: true };
  }
  if (!grantedByPlugin || !(current & Permission.ADMIN)) {
    return { permissions: current, grantedByPlugin: false };
  }
  return {
    permissions: current & ~Permission.ADMIN || defaults,
    grantedByPlugin: false,
  };
}

/** Returns the user's permissions after a sign-in and records who granted ADMIN. */
export async function syncPluginAdmin(
  user: Pick<User, 'permissions'>,
  jellyfinUserId: string,
  isAdministrator: boolean
): Promise<number> {
  const settings = getSettings();
  const admins = new Set(settings.plugin.jellyfinAdmins);
  const next = pluginAdminPermissions(
    user.permissions,
    isAdministrator,
    admins.has(jellyfinUserId),
    settings.main.defaultPermissions
  );
  if (next.grantedByPlugin !== admins.has(jellyfinUserId)) {
    if (next.grantedByPlugin) admins.add(jellyfinUserId);
    else admins.delete(jellyfinUserId);
    settings.plugin = { ...settings.plugin, jellyfinAdmins: [...admins] };
    await settings.save();
  }
  return next.permissions;
}

/**
 * A value from the plugin page wins. When the page has none, only a value the
 * plugin set earlier is cleared; one entered in Foreseerr stays.
 */
const pluginValue = (
  current: string | undefined,
  incoming: string,
  applied: string
): string => incoming || (current === applied ? '' : (current ?? ''));

export const jellyfinHostFilePath = (): string =>
  path.join(configDirectory(), 'jellyfin-host.json');

export async function readJellyfinHostFile(): Promise<JellyfinHostFile | null> {
  try {
    const raw = await readFile(jellyfinHostFilePath(), 'utf-8');
    return JSON.parse(raw) as JellyfinHostFile;
  } catch {
    return null;
  }
}

const mergeLibraries = (
  current: Library[],
  incoming: JellyfinHostLibrary[] | null | undefined
): Library[] | undefined => {
  if (!incoming) {
    return undefined;
  }
  const previous = new Map(current.map((library) => [library.id, library]));
  return incoming.map((library) => ({
    id: library.id,
    name: library.name,
    type: library.type,
    enabled: previous.get(library.id)?.enabled ?? library.enabled !== false,
    lastScan: previous.get(library.id)?.lastScan,
  }));
};

export function applyJellyfinHostFile(host: JellyfinHostFile): boolean {
  const settings = getSettings();
  let changed = false;

  settings.main.mediaServerType = MediaServerType.JELLYFIN;
  settings.main.mediaServerLogin = host.main?.mediaServerLogin ?? true;
  settings.main.localLogin = host.main?.localLogin ?? false;
  const plugin = settings.plugin;
  if (typeof host.main?.applicationUrl === 'string') {
    settings.main.applicationUrl = pluginValue(
      settings.main.applicationUrl,
      host.main.applicationUrl,
      plugin.applicationUrl
    );
    plugin.applicationUrl = host.main.applicationUrl;
  }
  if (host.main?.locale) {
    settings.main.locale = host.main.locale;
  }

  const jellyfinPatch: Partial<typeof settings.jellyfin> = {};
  const jf = host.jellyfin;
  if (jf) {
    if (jf.name) jellyfinPatch.name = jf.name;
    if (jf.ip) jellyfinPatch.ip = jf.ip;
    if (typeof jf.port === 'number') jellyfinPatch.port = jf.port;
    if (typeof jf.useSsl === 'boolean') jellyfinPatch.useSsl = jf.useSsl;
    if (typeof jf.urlBase === 'string') jellyfinPatch.urlBase = jf.urlBase;
    if (typeof jf.externalHostname === 'string') {
      jellyfinPatch.externalHostname = pluginValue(
        settings.jellyfin.externalHostname,
        jf.externalHostname,
        plugin.externalHostname
      );
      plugin.externalHostname = jf.externalHostname;
    }
    if (jf.serverId) jellyfinPatch.serverId = jf.serverId;
    if (jf.apiKey) jellyfinPatch.apiKey = jf.apiKey;
    const libraries = mergeLibraries(settings.jellyfin.libraries, jf.libraries);
    if (libraries) jellyfinPatch.libraries = libraries;
  }
  if (Object.keys(jellyfinPatch).length > 0) {
    settings.jellyfin = { ...settings.jellyfin, ...jellyfinPatch };
    changed = true;
  }

  // Better Trakt is only a default: a directly configured Trakt app wins.
  if (
    (host.trakt?.provider === 'jellyfin' ||
      host.trakt?.provider === 'direct') &&
    !settings.trakt.clientId
  ) {
    settings.trakt = { ...settings.trakt, provider: host.trakt.provider };
    changed = true;
  }

  if (!settings.public.initialized && settings.jellyfin.apiKey) {
    settings.public = { ...settings.public, initialized: true };
    changed = true;
  }

  return changed;
}

export async function loadJellyfinHostBootstrap(): Promise<boolean> {
  if (!isPluginMode()) {
    return false;
  }
  const host = await readJellyfinHostFile();
  if (!host) {
    logger.warn('Plugin mode is on but jellyfin-host.json was not found', {
      label: 'Plugin',
      path: jellyfinHostFilePath(),
    });
    return false;
  }
  applyJellyfinHostFile(host);
  await getSettings().save();
  logger.info('Merged managed Jellyfin host settings', { label: 'Plugin' });
  return true;
}

export async function ensurePluginAdminUser(): Promise<void> {
  if (!isPluginMode()) {
    return;
  }
  const host = await readJellyfinHostFile();
  const admin = host?.adminUser;
  if (!admin?.jellyfinUserId || !admin.jellyfinUsername) {
    return;
  }
  const { jellyfinUserId } = admin;
  const userRepository = getRepository(User);
  const existing = await userRepository.findOne({ where: { jellyfinUserId } });
  if (existing) {
    const permissions = await syncPluginAdmin(existing, jellyfinUserId, true);
    if (existing.permissions !== permissions) {
      existing.permissions = permissions;
      await userRepository.save(existing);
    }
    return;
  }
  const userCount = await userRepository.count();
  const user = new User({
    ...(userCount === 0 ? { id: 1 } : {}),
    email: await availablePluginEmail(
      admin.email || admin.jellyfinUsername,
      jellyfinUserId
    ),
    jellyfinUsername: admin.jellyfinUsername,
    jellyfinUserId,
    jellyfinDeviceId: 'BOT_seerr',
    permissions: getSettings().main.defaultPermissions,
    userType: UserType.JELLYFIN,
  });
  user.permissions = await syncPluginAdmin(user, jellyfinUserId, true);
  user.avatar = `/avatarproxy/${jellyfinUserId}`;
  await userRepository.save(user);
  logger.info('Created plugin admin user from Jellyfin host bootstrap', {
    label: 'Plugin',
    jellyfinUsername: admin.jellyfinUsername,
  });
}
