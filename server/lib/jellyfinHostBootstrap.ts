import type { Library } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { In } from 'typeorm';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
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
    libraries?: JellyfinHostLibrary[];
  };
  trakt?: {
    provider?: 'direct' | 'jellyfin';
  };
  mdblist?: {
    apiKey?: string;
  };
  webhook?: {
    url?: string;
    secret?: string;
  };
  adminUser?: JellyfinHostAdminUser;
}

export function jellyfinUserIdCandidates(id: string): string[] {
  const compact = id.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    return [id];
  }
  const dashed = `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
  return [...new Set([id, compact, dashed])];
}

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
  incoming: JellyfinHostLibrary[] | undefined
): Library[] | undefined => {
  if (!incoming) {
    return undefined;
  }
  const previous = new Map(current.map((library) => [library.id, library]));
  return incoming.map((library) => ({
    id: library.id,
    name: library.name,
    type: library.type,
    enabled: library.enabled !== false,
    lastScan: previous.get(library.id)?.lastScan,
  }));
};

export function applyJellyfinHostFile(host: JellyfinHostFile): boolean {
  const settings = getSettings();
  let changed = false;

  settings.main.mediaServerType = MediaServerType.JELLYFIN;
  settings.main.mediaServerLogin = host.main?.mediaServerLogin ?? true;
  settings.main.localLogin = host.main?.localLogin ?? false;
  if (host.main?.applicationUrl) {
    settings.main.applicationUrl = host.main.applicationUrl;
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
      jellyfinPatch.externalHostname = jf.externalHostname;
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

  if (
    host.trakt?.provider === 'jellyfin' ||
    host.trakt?.provider === 'direct'
  ) {
    settings.trakt = { ...settings.trakt, provider: host.trakt.provider };
    changed = true;
  }

  if (host.mdblist?.apiKey) {
    settings.mdblist = { ...settings.mdblist, apiKey: host.mdblist.apiKey };
    changed = true;
  }

  if (host.webhook?.url) {
    const current = settings.notifications.agents.webhook;
    const managed = (current.options.webhookUrl ?? '').includes(
      '/ForeseerrPlugin/Webhook'
    );
    if (!current.enabled || managed) {
      settings.notifications.agents.webhook = {
        ...current,
        enabled: true,
        types: 3918,
        options: {
          ...current.options,
          webhookUrl: host.webhook.url,
          authHeader: host.webhook.secret
            ? `Bearer ${host.webhook.secret}`
            : current.options.authHeader,
        },
      };
      changed = true;
    }
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
  const userRepository = getRepository(User);
  const existing = await userRepository.findOne({
    where: {
      jellyfinUserId: In(jellyfinUserIdCandidates(admin.jellyfinUserId)),
    },
  });
  if (existing) {
    if (existing.id === 1 && existing.permissions !== Permission.ADMIN) {
      existing.permissions = Permission.ADMIN;
      await userRepository.save(existing);
    }
    return;
  }
  const userCount = await userRepository.count();
  const user = new User({
    ...(userCount === 0 ? { id: 1 } : {}),
    email: (admin.email || admin.jellyfinUsername).toLowerCase(),
    jellyfinUsername: admin.jellyfinUsername,
    jellyfinUserId: admin.jellyfinUserId,
    jellyfinDeviceId: 'BOT_seerr',
    permissions: Permission.ADMIN,
    userType: UserType.JELLYFIN,
  });
  user.avatar = `/avatarproxy/${admin.jellyfinUserId}`;
  await userRepository.save(user);
  logger.info('Created plugin admin user from Jellyfin host bootstrap', {
    label: 'Plugin',
    jellyfinUsername: admin.jellyfinUsername,
  });
}
