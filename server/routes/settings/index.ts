import JellyfinAPI from '@server/api/jellyfin';
import PlexAPI from '@server/api/plexapi';
import PlexTvAPI from '@server/api/plextv';
import TautulliAPI from '@server/api/tautulli';
import TraktAPI from '@server/api/trakt';
import { ApiErrorCode } from '@server/constants/error';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import type { PlexConnection } from '@server/interfaces/api/plexInterfaces';
import type {
  LogMessage,
  LogsResultsResponse,
  SettingsAboutResponse,
} from '@server/interfaces/api/settingsInterfaces';
import { scheduledJobs } from '@server/job/schedule';
import type { AvailableCacheIds } from '@server/lib/cache';
import cacheManager from '@server/lib/cache';
import ImageProxy from '@server/lib/imageproxy';
import {
  clearIntegrationHealthCache,
  getIntegrationHealth,
} from '@server/lib/integrationHealth';
import { clearSyncCache } from '@server/lib/mediaActions/syncCache';
import { Permission } from '@server/lib/permissions';
import { clearMdblistProviderState } from '@server/lib/ratings';
import { jellyfinFullScanner } from '@server/lib/scanners/jellyfin';
import { plexFullScanner } from '@server/lib/scanners/plex';
import type { JobId, Library, MainSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import {
  countLinkedTraktAccounts,
  disconnectAllTraktLinks,
} from '@server/lib/trakt';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import discoverSettingRoutes from '@server/routes/settings/discover';
import { ApiError } from '@server/types/error';
import { appDataPath } from '@server/utils/appDataVolume';
import { getAppVersion } from '@server/utils/appVersion';
import { dnsCache } from '@server/utils/dnsCache';
import { getHostname } from '@server/utils/getHostname';
import type { DnsEntries, DnsStats } from 'dns-caching';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import { escapeRegExp, merge, omit, set, sortBy } from 'lodash';
import { rescheduleJob } from 'node-schedule';
import path from 'path';
import semver from 'semver';
import { URL } from 'url';
import metadataRoutes from './metadata';
import notificationRoutes from './notifications';
import radarrRoutes from './radarr';
import sonarrRoutes from './sonarr';

const settingsRoutes = Router();

settingsRoutes.use('/notifications', notificationRoutes);
settingsRoutes.use('/radarr', radarrRoutes);
settingsRoutes.use('/sonarr', sonarrRoutes);
settingsRoutes.use('/discover', discoverSettingRoutes);
settingsRoutes.use('/metadatas', metadataRoutes);

const filteredMainSettings = (
  user: User,
  main: MainSettings
): Partial<MainSettings> => {
  if (!user?.hasPermission(Permission.ADMIN)) {
    return omit(main, 'apiKey');
  }

  return main;
};

settingsRoutes.get('/main', (req, res, next) => {
  const settings = getSettings();

  if (!req.user) {
    return next({ status: 400, message: 'User missing from request.' });
  }

  res.status(200).json(filteredMainSettings(req.user, settings.main));
});

settingsRoutes.post('/main', async (req, res) => {
  const settings = getSettings();

  settings.main = merge(settings.main, req.body);
  await settings.save();

  return res.status(200).json(settings.main);
});

settingsRoutes.get('/network', (req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.network);
});

settingsRoutes.post('/network', async (req, res) => {
  const settings = getSettings();

  settings.network = merge(settings.network, req.body);
  await settings.save();

  return res.status(200).json(settings.network);
});

settingsRoutes.post('/main/regenerate', async (req, res, next) => {
  const settings = getSettings();

  const main = await settings.regenerateApiKey();

  if (!req.user) {
    return next({ status: 500, message: 'User missing from request.' });
  }

  return res.status(200).json(filteredMainSettings(req.user, main));
});

settingsRoutes.get('/plex', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.plex);
});

settingsRoutes.post('/plex', async (req, res, next) => {
  const userRepository = getRepository(User);
  const settings = getSettings();
  try {
    const admin = await userRepository.findOneOrFail({
      select: { id: true, plexToken: true },
      where: { id: 1 },
    });

    Object.assign(settings.plex, req.body);

    const plexClient = new PlexAPI({ plexToken: admin.plexToken });

    const result = await plexClient.getStatus();

    if (!result?.MediaContainer?.machineIdentifier) {
      throw new Error('Server not found');
    }

    settings.plex.machineId = result.MediaContainer.machineIdentifier;
    settings.plex.name = result.MediaContainer.friendlyName;

    await settings.save();
  } catch (e) {
    logger.error('Something went wrong testing Plex connection', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to connect to Plex.',
    });
  }

  return res.status(200).json(settings.plex);
});

settingsRoutes.get('/plex/devices/servers', async (req, res, next) => {
  const userRepository = getRepository(User);
  try {
    const admin = await userRepository.findOneOrFail({
      select: { id: true, plexToken: true },
      where: { id: 1 },
    });
    const plexTvClient = admin.plexToken
      ? new PlexTvAPI(admin.plexToken)
      : null;
    const devices = (await plexTvClient?.getDevices())?.filter((device) => {
      return device.provides.includes('server') && device.owned;
    });
    const settings = getSettings();

    if (devices) {
      await Promise.all(
        devices.map(async (device) => {
          const plexDirectConnections: PlexConnection[] = [];

          device.connection.forEach((connection) => {
            const url = new URL(connection.uri);

            if (url.hostname !== connection.address) {
              const plexDirectConnection = { ...connection };
              plexDirectConnection.address = url.hostname;
              plexDirectConnections.push(plexDirectConnection);

              // Connect to IP addresses over HTTP
              connection.protocol = 'http';
            }
          });

          plexDirectConnections.forEach((plexDirectConnection) => {
            device.connection.push(plexDirectConnection);
          });

          await Promise.all(
            device.connection.map(async (connection) => {
              const plexDeviceSettings = {
                ...settings.plex,
                ip: connection.address,
                port: connection.port,
                useSsl: connection.protocol === 'https',
              };
              const plexClient = new PlexAPI({
                plexToken: admin.plexToken,
                plexSettings: plexDeviceSettings,
                timeout: 5000,
              });

              try {
                await plexClient.getStatus();
                connection.status = 200;
                connection.message = 'OK';
              } catch (e) {
                connection.status = 500;
                connection.message = e.message.split(':')[0];
              }
            })
          );
        })
      );
    }
    return res.status(200).json(devices);
  } catch (e) {
    logger.error('Something went wrong retrieving Plex server list', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve Plex server list.',
    });
  }
});

settingsRoutes.get('/plex/library', async (req, res) => {
  const settings = getSettings();

  if (req.query.sync) {
    const userRepository = getRepository(User);
    const admin = await userRepository.findOneOrFail({
      select: { id: true, plexToken: true },
      where: { id: 1 },
    });
    const plexapi = new PlexAPI({ plexToken: admin.plexToken });

    await plexapi.syncLibraries();
  }

  const enabledLibraries = req.query.enable
    ? (req.query.enable as string).split(',')
    : [];
  settings.plex.libraries = settings.plex.libraries.map((library) => ({
    ...library,
    enabled: enabledLibraries.includes(library.id),
  }));
  await settings.save();
  return res.status(200).json(settings.plex.libraries);
});

settingsRoutes.get('/plex/sync', (_req, res) => {
  return res.status(200).json(plexFullScanner.status());
});

settingsRoutes.post('/plex/sync', (req, res) => {
  if (req.body.cancel) {
    plexFullScanner.cancel();
  } else if (req.body.start) {
    plexFullScanner.run();
  }
  return res.status(200).json(plexFullScanner.status());
});

settingsRoutes.get('/jellyfin', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.jellyfin);
});

settingsRoutes.post('/jellyfin', async (req, res, next) => {
  const userRepository = getRepository(User);
  const settings = getSettings();

  try {
    const admin = await userRepository.findOneOrFail({
      where: { id: 1 },
      select: ['id', 'jellyfinUserId', 'jellyfinDeviceId'],
      order: { id: 'ASC' },
    });

    const tempJellyfinSettings = { ...settings.jellyfin, ...req.body };

    const jellyfinClient = new JellyfinAPI(
      getHostname(tempJellyfinSettings),
      tempJellyfinSettings.apiKey,
      admin.jellyfinDeviceId ?? ''
    );

    const result = await jellyfinClient.getSystemInfo();

    if (!result?.Id) {
      throw new ApiError(result?.status, ApiErrorCode.InvalidUrl);
    }

    Object.assign(settings.jellyfin, req.body);
    settings.jellyfin.serverId = result.Id;
    settings.jellyfin.name = result.ServerName;
    await settings.save();
    clearIntegrationHealthCache();
  } catch (e) {
    if (e instanceof ApiError) {
      logger.error('Something went wrong testing Jellyfin connection', {
        label: 'API',
        status: e.statusCode,
        errorMessage: ApiErrorCode.InvalidUrl,
      });

      return next({
        status: e.statusCode,
        message: ApiErrorCode.InvalidUrl,
      });
    } else {
      logger.error('Something went wrong', {
        label: 'API',
        errorMessage: e.message,
      });

      return next({
        status: e.statusCode ?? 500,
        message: ApiErrorCode.Unknown,
      });
    }
  }

  return res.status(200).json(settings.jellyfin);
});

settingsRoutes.get('/jellyfin/library', async (req, res, next) => {
  const settings = getSettings();

  if (req.query.sync) {
    const userRepository = getRepository(User);
    const admin = await userRepository.findOneOrFail({
      select: ['id', 'jellyfinDeviceId', 'jellyfinUserId'],
      where: { id: 1 },
      order: { id: 'ASC' },
    });
    const jellyfinClient = new JellyfinAPI(
      getHostname(),
      settings.jellyfin.apiKey,
      admin.jellyfinDeviceId ?? ''
    );

    jellyfinClient.setUserId(admin.jellyfinUserId ?? '');

    const libraries = await jellyfinClient.getLibraries();

    if (libraries.length === 0) {
      // Check if no libraries are found due to the fallback to user views
      // This only affects LDAP users
      const account = await jellyfinClient.getUser();

      // Automatic Library grouping is not supported when user views are used to get library
      if (account.Configuration.GroupedFolders?.length > 0) {
        return next({
          status: 501,
          message: ApiErrorCode.SyncErrorGroupedFolders,
        });
      }

      return next({ status: 404, message: ApiErrorCode.SyncErrorNoLibraries });
    }

    const newLibraries: Library[] = libraries.map((library) => {
      const existing = settings.jellyfin.libraries.find(
        (l) => l.id === library.key && l.name === library.title
      );

      return {
        id: library.key,
        name: library.title,
        enabled: existing?.enabled ?? false,
        type: library.type,
      };
    });

    settings.jellyfin.libraries = newLibraries;
  }

  const enabledLibraries = req.query.enable
    ? (req.query.enable as string).split(',')
    : [];
  settings.jellyfin.libraries = settings.jellyfin.libraries.map((library) => ({
    ...library,
    enabled: enabledLibraries.includes(library.id),
  }));
  await settings.save();
  return res.status(200).json(settings.jellyfin.libraries);
});

settingsRoutes.get('/jellyfin/users', async (req, res) => {
  const settings = getSettings();

  const userRepository = getRepository(User);
  const admin = await userRepository.findOneOrFail({
    select: ['id', 'jellyfinDeviceId', 'jellyfinUserId'],
    where: { id: 1 },
    order: { id: 'ASC' },
  });
  const jellyfinClient = new JellyfinAPI(
    getHostname(),
    settings.jellyfin.apiKey,
    admin.jellyfinDeviceId ?? ''
  );

  jellyfinClient.setUserId(admin.jellyfinUserId ?? '');
  const resp = await jellyfinClient.getUsers();
  const users = resp.users.map((user) => ({
    username: user.Name,
    id: user.Id,
    thumb: `/avatarproxy/${user.Id}`,
    email: user.Name,
  }));

  return res.status(200).json(users);
});

settingsRoutes.get('/jellyfin/sync', (_req, res) => {
  return res.status(200).json(jellyfinFullScanner.status());
});

settingsRoutes.post('/jellyfin/sync', (req, res) => {
  if (req.body.cancel) {
    jellyfinFullScanner.cancel();
  } else if (req.body.start) {
    jellyfinFullScanner.run();
  }
  return res.status(200).json(jellyfinFullScanner.status());
});
settingsRoutes.get('/tautulli', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.tautulli);
});

settingsRoutes.post('/tautulli', async (req, res, next) => {
  const settings = getSettings();

  Object.assign(settings.tautulli, req.body);

  if (settings.tautulli.hostname) {
    try {
      const tautulliClient = new TautulliAPI(settings.tautulli);

      const result = await tautulliClient.getInfo();

      if (!semver.gte(semver.coerce(result?.tautulli_version) ?? '', '2.9.0')) {
        throw new Error('Tautulli version not supported');
      }

      await settings.save();
    } catch (e) {
      logger.error('Something went wrong testing Tautulli connection', {
        label: 'API',
        errorMessage: e.message,
      });
      return next({
        status: 500,
        message: 'Unable to connect to Tautulli.',
      });
    }
  }

  return res.status(200).json(settings.tautulli);
});

settingsRoutes.get('/trakt', async (_req, res) => {
  const settings = getSettings();
  const linkedAccountCount = await countLinkedTraktAccounts();
  const provider =
    settings.trakt.provider === 'jellyfin' ? 'jellyfin' : 'direct';

  res.status(200).json({
    provider,
    clientId: settings.trakt.clientId,
    // Never return the full secret; indicate whether one is set
    clientSecret: settings.trakt.clientSecret ? '********' : '',
    configured:
      provider === 'jellyfin'
        ? Boolean(settings.jellyfin.ip)
        : Boolean(settings.trakt.clientId && settings.trakt.clientSecret),
    actionsEnabled: settings.mediaActions?.providers?.trakt !== false,
    linkedAccountCount,
  });
});

settingsRoutes.get('/integrations/status', async (_req, res, next) => {
  try {
    return res.status(200).json(await getIntegrationHealth());
  } catch (e) {
    logger.error('Unable to check integration health', {
      label: 'Settings',
      errorMessage: e instanceof Error ? e.message : 'unknown error',
    });
    return next({
      status: 500,
      message: 'Unable to check integration health.',
    });
  }
});

settingsRoutes.post('/integrations/status/refresh', async (_req, res, next) => {
  try {
    clearIntegrationHealthCache();
    return res.status(200).json(await getIntegrationHealth());
  } catch (e) {
    logger.error('Unable to refresh integration health', {
      label: 'Settings',
      errorMessage: e instanceof Error ? e.message : 'unknown error',
    });
    return next({
      status: 500,
      message: 'Unable to refresh integration health.',
    });
  }
});

settingsRoutes.post('/trakt/actions', async (req, res, next) => {
  if (typeof req.body.actionsEnabled !== 'boolean') {
    return next({
      status: 400,
      message: 'actionsEnabled must be a boolean.',
    });
  }

  try {
    const settings = getSettings();
    settings.mediaActions = {
      providers: {
        trakt: req.body.actionsEnabled,
        jellyfin: settings.mediaActions.providers.jellyfin,
      },
    };
    await settings.save();
    return res.status(200).json({ actionsEnabled: req.body.actionsEnabled });
  } catch (e) {
    logger.error('Unable to update Trakt action settings', {
      label: 'Settings',
      errorMessage: e instanceof Error ? e.message : 'unknown error',
    });
    return next({ status: 500, message: 'Unable to update Trakt actions.' });
  }
});

settingsRoutes.post('/trakt', async (req, res, next) => {
  const settings = getSettings();

  try {
    const provider = req.body.provider === 'jellyfin' ? 'jellyfin' : 'direct';
    const previousProvider =
      settings.trakt.provider === 'jellyfin' ? 'jellyfin' : 'direct';
    const previousClientId = settings.trakt.clientId;
    const previousClientSecret = settings.trakt.clientSecret;
    let clientId = String(req.body.clientId ?? '').trim();
    let clientSecret = String(req.body.clientSecret ?? '').trim();

    if (provider === 'jellyfin') {
      // Better Trakt obtains its credentials from Jellyfin. Do not retain
      // unused direct Trakt application credentials in settings.json.
      clientId = '';
      clientSecret = '';
    } else if (!clientSecret || clientSecret === '********') {
      // Preserve the existing secret when the masked placeholder is submitted.
      clientSecret = settings.trakt.clientSecret;
    }

    const credentialsChanging =
      previousClientId !== clientId || previousClientSecret !== clientSecret;
    const providerChanging = previousProvider !== provider;

    if (provider === 'direct' && (!clientId || !clientSecret)) {
      return res.status(400).json({
        message: 'A Trakt Client ID and Client Secret are required.',
      });
    }

    if (provider === 'jellyfin' && providerChanging) {
      if (req.body.confirmProviderSwitch !== true) {
        return res.status(400).json({
          message:
            'Switching to Better Trakt clears Direct Trakt credentials and linked accounts. Set confirmProviderSwitch to true to proceed.',
        });
      }
      if (!settings.jellyfin.ip || !settings.jellyfin.apiKey) {
        return res.status(400).json({
          message: 'Configure Jellyfin before switching to Better Trakt.',
        });
      }
      try {
        await new JellyfinAPI(
          getHostname(),
          settings.jellyfin.apiKey
        ).getSystemInfo();
      } catch {
        return res.status(400).json({
          message:
            'Jellyfin could not be reached. Fix the Jellyfin connection before switching.',
        });
      }
    }

    if (provider === 'direct' && credentialsChanging) {
      const linkedAccountCount = await countLinkedTraktAccounts();
      if (
        linkedAccountCount > 0 &&
        req.body.confirmDisconnectLinkedAccounts !== true
      ) {
        return res.status(400).json({
          message:
            'Changing Trakt credentials will disconnect all linked user accounts. Set confirmDisconnectLinkedAccounts to true to proceed.',
          linkedAccountCount,
        });
      }

      const validationClient = new TraktAPI({ clientId, clientSecret });
      await validationClient.validateApplicationCredentials();
    }

    settings.trakt = {
      provider,
      clientId,
      clientSecret,
    };
    settings.mediaActions = {
      providers: {
        trakt: req.body.actionsEnabled !== false,
        jellyfin: settings.mediaActions.providers.jellyfin,
      },
    };
    await settings.save();
    clearIntegrationHealthCache();

    if (provider === 'direct' && credentialsChanging) {
      const disconnectedAccountCount = await disconnectAllTraktLinks();
      clearSyncCache();
      logger.info('Disconnected Trakt accounts after credential change', {
        label: 'Settings',
        disconnectedAccountCount,
      });
    } else if (provider === 'jellyfin' && providerChanging) {
      const disconnectedAccountCount = await disconnectAllTraktLinks();
      logger.info('Disconnected Direct Trakt accounts after provider switch', {
        label: 'Settings',
        disconnectedAccountCount,
      });
    }

    if (providerChanging) {
      clearSyncCache();
    }

    return res.status(200).json({
      provider,
      clientId: settings.trakt.clientId,
      clientSecret: settings.trakt.clientSecret ? '********' : '',
      configured:
        provider === 'jellyfin'
          ? Boolean(settings.jellyfin.ip)
          : Boolean(settings.trakt.clientId && settings.trakt.clientSecret),
      actionsEnabled: settings.mediaActions.providers.trakt !== false,
      linkedAccountCount: await countLinkedTraktAccounts(),
    });
  } catch (e) {
    logger.error('Something went wrong saving Trakt settings', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to save Trakt settings.',
    });
  }
});

const boolOrDefault = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }
  return fallback;
};

const mdblistSettingsResponse = () => {
  const settings = getSettings();
  const m = settings.mdblist;
  return {
    apiKey: m.apiKey ? '********' : '',
    configured: Boolean(m.apiKey?.trim()),
    showTmdb: m.showTmdb,
    showImdb: m.showImdb,
    showRt: m.showRt,
    showRtUser: m.showRtUser,
    showMetacritic: m.showMetacritic,
    showTraktCommunity: m.showTraktCommunity,
    posterTmdb: m.posterTmdb,
    posterImdb: m.posterImdb,
    posterRt: m.posterRt,
    posterRtUser: m.posterRtUser,
    posterMetacritic: m.posterMetacritic,
    posterTraktCommunity: m.posterTraktCommunity,
  };
};

settingsRoutes.get('/mdblist', (_req, res) => {
  res.status(200).json(mdblistSettingsResponse());
});

settingsRoutes.post('/mdblist', async (req, res, next) => {
  const settings = getSettings();

  try {
    const clearingKey = req.body.clearApiKey === true;
    const previousApiKey = settings.mdblist.apiKey;
    let apiKey = String(req.body.apiKey ?? '').trim();

    if (clearingKey) {
      apiKey = '';
    } else if (!apiKey || apiKey === '********') {
      // Preserve existing key when the masked placeholder is submitted
      apiKey = settings.mdblist.apiKey;
    }

    settings.mdblist = {
      apiKey,
      showTmdb: req.body.showTmdb !== false,
      showImdb: req.body.showImdb !== false,
      showRt: req.body.showRt !== false,
      showRtUser: req.body.showRtUser !== false,
      showMetacritic: req.body.showMetacritic !== false,
      showTraktCommunity: req.body.showTraktCommunity !== false,
      // Poster idle: explicit false allowed; missing keys keep prior/default
      posterTmdb: boolOrDefault(
        req.body.posterTmdb,
        settings.mdblist.posterTmdb
      ),
      posterImdb: boolOrDefault(
        req.body.posterImdb,
        settings.mdblist.posterImdb
      ),
      posterRt: boolOrDefault(req.body.posterRt, settings.mdblist.posterRt),
      posterRtUser: boolOrDefault(
        req.body.posterRtUser,
        settings.mdblist.posterRtUser
      ),
      posterMetacritic: boolOrDefault(
        req.body.posterMetacritic,
        settings.mdblist.posterMetacritic
      ),
      posterTraktCommunity: boolOrDefault(
        req.body.posterTraktCommunity,
        settings.mdblist.posterTraktCommunity
      ),
    };
    await settings.save();
    clearIntegrationHealthCache();

    if (clearingKey || apiKey !== previousApiKey) {
      clearMdblistProviderState();
      logger.info('Reset MDBList provider state after credential change', {
        label: 'Settings',
        cleared: clearingKey,
      });
    }

    return res.status(200).json(mdblistSettingsResponse());
  } catch (e) {
    logger.error('Something went wrong saving MDBList settings', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to save MDBList settings.',
    });
  }
});

settingsRoutes.get(
  '/plex/users',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    const userRepository = getRepository(User);
    const qb = userRepository.createQueryBuilder('user');

    try {
      const admin = await userRepository.findOneOrFail({
        select: { id: true, plexToken: true },
        where: { id: 1 },
      });
      const plexApi = new PlexTvAPI(admin.plexToken ?? '');
      const plexUsers = (await plexApi.getUsers()).MediaContainer.User.map(
        (user) => user.$
      ).filter((user) => user.email);

      const unimportedPlexUsers: {
        id: string;
        title: string;
        username: string;
        email: string;
        thumb: string;
      }[] = [];

      const plexIds = plexUsers.map((plexUser) => plexUser.id);
      const plexEmails = plexUsers.map((plexUser) =>
        plexUser.email.toLowerCase()
      );
      if (!plexIds.length) plexIds.push('-1');
      if (!plexEmails.length) plexEmails.push('@');

      const existingUsers = await qb
        .where('user.plexId IN (:...plexIds)', { plexIds })
        .orWhere('user.email IN (:...plexEmails)', { plexEmails })
        .getMany();

      await Promise.all(
        plexUsers.map(async (plexUser) => {
          if (
            !existingUsers.find(
              (user) =>
                user.plexId === parseInt(plexUser.id) ||
                user.email === plexUser.email.toLowerCase()
            ) &&
            (await plexApi.checkUserAccess(parseInt(plexUser.id)))
          ) {
            unimportedPlexUsers.push(plexUser);
          }
        })
      );

      return res.status(200).json(sortBy(unimportedPlexUsers, 'username'));
    } catch (e) {
      logger.error('Something went wrong getting unimported Plex users', {
        label: 'API',
        errorMessage: e.message,
      });
      next({
        status: 500,
        message: 'Unable to retrieve unimported Plex users.',
      });
    }
  }
);

settingsRoutes.get(
  '/logs',
  rateLimit({ windowMs: 60 * 1000, max: 50 }),
  (req, res, next) => {
    const pageSize = req.query.take ? Number(req.query.take) : 25;
    const skip = req.query.skip ? Number(req.query.skip) : 0;
    const search = (req.query.search as string) ?? '';
    const searchRegexp = new RegExp(escapeRegExp(search), 'i');

    let filter: string[] = [];
    switch (req.query.filter) {
      case 'debug':
        filter.push('debug');
      // falls through
      case 'info':
        filter.push('info');
      // falls through
      case 'warn':
        filter.push('warn');
      // falls through
      case 'error':
        filter.push('error');
        break;
      default:
        filter = ['debug', 'info', 'warn', 'error'];
    }

    const logFile = process.env.CONFIG_DIRECTORY
      ? `${process.env.CONFIG_DIRECTORY}/logs/.machinelogs.json`
      : path.join(__dirname, '../../../config/logs/.machinelogs.json');
    const logs: LogMessage[] = [];
    const logMessageProperties = [
      'timestamp',
      'level',
      'label',
      'message',
      'data',
    ];

    const deepValueStrings = (obj: Record<string, unknown>): string[] => {
      const values = [];

      for (const val of Object.values(obj)) {
        if (typeof val === 'string') {
          values.push(val);
        } else if (typeof val === 'number') {
          values.push(val.toString());
        } else if (val !== null && typeof val === 'object') {
          values.push(...deepValueStrings(val as Record<string, unknown>));
        }
      }

      return values;
    };

    try {
      fs.readFileSync(logFile, 'utf-8')
        .split('\n')
        .forEach((line) => {
          if (!line.length) return;

          const logMessage = JSON.parse(line);

          if (!filter.includes(logMessage.level)) {
            return;
          }

          if (
            !Object.keys(logMessage).every((key) =>
              logMessageProperties.includes(key)
            )
          ) {
            Object.keys(logMessage)
              .filter((prop) => !logMessageProperties.includes(prop))
              .forEach((prop) => {
                set(logMessage, `data.${prop}`, logMessage[prop]);
              });
          }

          if (req.query.search) {
            if (
              // label and data are sometimes undefined
              !searchRegexp.test(logMessage.label ?? '') &&
              !searchRegexp.test(logMessage.message) &&
              !deepValueStrings(logMessage.data ?? {}).some((val) =>
                searchRegexp.test(val)
              )
            ) {
              return;
            }
          }

          logs.push(logMessage);
        });

      const displayedLogs = logs.reverse().slice(skip, skip + pageSize);

      return res.status(200).json({
        pageInfo: {
          pages: Math.ceil(logs.length / pageSize),
          pageSize,
          results: logs.length,
          page: Math.ceil(skip / pageSize) + 1,
        },
        results: displayedLogs,
      } as LogsResultsResponse);
    } catch (error) {
      logger.error('Something went wrong while retrieving logs', {
        label: 'Logs',
        errorMessage: error.message,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve logs.',
      });
    }
  }
);

settingsRoutes.get('/jobs', (_req, res) => {
  return res.status(200).json(
    scheduledJobs.map((job) => ({
      id: job.id,
      name: job.name,
      type: job.type,
      interval: job.interval,
      cronSchedule: job.cronSchedule,
      nextExecutionTime: job.job.nextInvocation(),
      running: job.running ? job.running() : false,
    }))
  );
});

settingsRoutes.post<{ jobId: string }>('/jobs/:jobId/run', (req, res, next) => {
  const scheduledJob = scheduledJobs.find((job) => job.id === req.params.jobId);

  if (!scheduledJob) {
    return next({ status: 404, message: 'Job not found.' });
  }

  scheduledJob.job.invoke();

  return res.status(200).json({
    id: scheduledJob.id,
    name: scheduledJob.name,
    type: scheduledJob.type,
    interval: scheduledJob.interval,
    cronSchedule: scheduledJob.cronSchedule,
    nextExecutionTime: scheduledJob.job.nextInvocation(),
    running: scheduledJob.running ? scheduledJob.running() : false,
  });
});

settingsRoutes.post<{ jobId: JobId }>(
  '/jobs/:jobId/cancel',
  (req, res, next) => {
    const scheduledJob = scheduledJobs.find(
      (job) => job.id === req.params.jobId
    );

    if (!scheduledJob) {
      return next({ status: 404, message: 'Job not found.' });
    }

    if (scheduledJob.cancelFn) {
      scheduledJob.cancelFn();
    }

    return res.status(200).json({
      id: scheduledJob.id,
      name: scheduledJob.name,
      type: scheduledJob.type,
      interval: scheduledJob.interval,
      cronSchedule: scheduledJob.cronSchedule,
      nextExecutionTime: scheduledJob.job.nextInvocation(),
      running: scheduledJob.running ? scheduledJob.running() : false,
    });
  }
);

settingsRoutes.post<{ jobId: JobId }>(
  '/jobs/:jobId/schedule',
  async (req, res, next) => {
    const scheduledJob = scheduledJobs.find(
      (job) => job.id === req.params.jobId
    );

    if (!scheduledJob) {
      return next({ status: 404, message: 'Job not found.' });
    }

    const result = rescheduleJob(scheduledJob.job, req.body.schedule);
    const settings = getSettings();

    if (result) {
      settings.jobs[scheduledJob.id].schedule = req.body.schedule;
      await settings.save();

      scheduledJob.cronSchedule = req.body.schedule;

      return res.status(200).json({
        id: scheduledJob.id,
        name: scheduledJob.name,
        type: scheduledJob.type,
        interval: scheduledJob.interval,
        cronSchedule: scheduledJob.cronSchedule,
        nextExecutionTime: scheduledJob.job.nextInvocation(),
        running: scheduledJob.running ? scheduledJob.running() : false,
      });
    } else {
      return next({ status: 400, message: 'Invalid job schedule.' });
    }
  }
);

settingsRoutes.get('/cache', async (_req, res) => {
  const cacheManagerCaches = cacheManager.getAllCaches();

  const apiCaches = Object.values(cacheManagerCaches).map((cache) => ({
    id: cache.id,
    name: cache.name,
    stats: cache.getStats(),
  }));

  const tmdbImageCache = await ImageProxy.getImageStats('tmdb');
  const avatarImageCache = await ImageProxy.getImageStats('avatar');

  const stats: DnsStats | undefined = dnsCache?.getStats();
  const entries: DnsEntries | undefined = dnsCache?.getCacheEntries();

  return res.status(200).json({
    apiCaches,
    imageCache: {
      tmdb: tmdbImageCache,
      avatar: avatarImageCache,
    },
    dnsCache: {
      stats,
      entries,
    },
  });
});

settingsRoutes.post<{ cacheId: AvailableCacheIds }>(
  '/cache/:cacheId/flush',
  (req, res, next) => {
    const cache = cacheManager.getCache(req.params.cacheId);

    if (cache) {
      cache.flush();
      return res.status(204).send();
    }

    next({ status: 404, message: 'Cache not found.' });
  }
);

settingsRoutes.post<{ dnsEntry: string }>(
  '/cache/dns/:dnsEntry/flush',
  (req, res, next) => {
    const dnsEntry = req.params.dnsEntry;

    if (dnsCache) {
      dnsCache.clear(dnsEntry);
      return res.status(204).send();
    }

    next({ status: 404, message: 'Cache not found.' });
  }
);

settingsRoutes.post(
  '/initialize',
  isAuthenticated(Permission.ADMIN),
  async (_req, res) => {
    const settings = getSettings();

    settings.public.initialized = true;
    await settings.save();

    return res.status(200).json(settings.public);
  }
);

settingsRoutes.get('/about', async (req, res) => {
  const mediaRepository = getRepository(Media);
  const mediaRequestRepository = getRepository(MediaRequest);

  const totalMediaItems = await mediaRepository.count();
  const totalRequests = await mediaRequestRepository.count();

  return res.status(200).json({
    version: getAppVersion(),
    totalMediaItems,
    totalRequests,
    tz: process.env.TZ,
    appDataPath: appDataPath(),
  } as SettingsAboutResponse);
});

export default settingsRoutes;
