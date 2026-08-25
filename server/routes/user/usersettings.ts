import AnilistAPI from '@server/api/anilist';
import JellyfinAPI from '@server/api/jellyfin';
import PlexTvAPI from '@server/api/plextv';
import TraktAPI from '@server/api/trakt';
import { ApiErrorCode } from '@server/constants/error';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import type {
  UserSettingsGeneralResponse,
  UserSettingsNotificationsResponse,
} from '@server/interfaces/api/userSettingsInterfaces';
import {
  AnilistAccountAlreadyLinkedError,
  AnilistNotConfiguredError,
  assertAnilistAccountAvailable,
  clearUserAnilistCredentials,
  getAnilistAppCredentials,
  getUserAnilistSettings,
  isAnilistTokenExpired,
} from '@server/lib/anilist';
import {
  parseDiscoverFilterDefaults,
  type DiscoverFilterDefaults,
} from '@server/lib/discover/filterDefaults';
import { invalidateUserAnilistSyncCache } from '@server/lib/mediaActions/anilistSyncCache';
import { invalidateUserSyncCache } from '@server/lib/mediaActions/syncCache';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import {
  optionalSkippedEpisodeProgressThreshold,
  skippedEpisodeProgressThreshold,
} from '@server/lib/skippedEpisodeEndings';
import {
  TraktAccountAlreadyLinkedError,
  TraktNotConfiguredError,
  assertTraktAccountAvailable,
  clearUserTraktCredentials,
  createTraktAppClient,
  ensureUserSettings,
  getUserTraktSettings,
  isJellyfinTraktProvider,
  resolveJellyfinTraktUserState,
  type JellyfinTraktPluginState,
} from '@server/lib/trakt';
import {
  TRAKT_DEVICE_SLOW_DOWN_SECONDS,
  clearTraktDeviceAuthSession,
  enforceTraktDevicePollInterval,
  noteTraktDevicePollSlowDown,
  rememberTraktDeviceAuthSession,
  traktDeviceCodeCreationLimiter,
  traktDevicePollLimiter,
} from '@server/lib/trakt/deviceAuthThrottle';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { quickConnectSecret } from '@server/routes/auth';
import { ApiError } from '@server/types/error';
import { getHostname } from '@server/utils/getHostname';
import {
  isOwnProfile,
  isOwnProfileOrAdmin,
} from '@server/utils/profileMiddleware';
import { Router } from 'express';
import net from 'net';
import { Not } from 'typeorm';
import { canMakePermissionsChange } from '.';

const userSettingsRoutes = Router({ mergeParams: true });

function userActionsEnabled(value?: boolean | null): boolean {
  return value !== false;
}

async function getTraktLinkedAccountPayload(
  userId: number,
  options: { includePluginStatus?: boolean } = {}
) {
  const settings = await getUserTraktSettings(userId);
  const actionsEnabled = userActionsEnabled(settings?.mediaActionsTraktEnabled);
  if (isJellyfinTraktProvider()) {
    const user = await getRepository(User)
      .createQueryBuilder('user')
      .addSelect('user.jellyfinAuthToken')
      .addSelect('user.jellyfinDeviceId')
      .where('user.id = :userId', { userId })
      .getOne();
    const connected = Boolean(user?.jellyfinUserId && user.jellyfinAuthToken);
    const payload: {
      provider: 'jellyfin';
      connected: boolean;
      needsJellyfinSessionRefresh: boolean;
      pluginState?: JellyfinTraktPluginState;
      username: string | null;
      actionsEnabled: boolean;
    } = {
      provider: 'jellyfin',
      connected,
      needsJellyfinSessionRefresh: Boolean(
        user?.jellyfinUserId && !user.jellyfinAuthToken
      ),
      username: connected ? (user?.jellyfinUsername ?? 'Jellyfin') : null,
      actionsEnabled,
    };
    if (options.includePluginStatus) {
      payload.pluginState = !user?.jellyfinUserId
        ? 'needs_jellyfin'
        : await resolveJellyfinTraktUserState(user);
      payload.needsJellyfinSessionRefresh =
        payload.pluginState === 'needs_session_refresh';
    }
    return payload;
  }
  const connected = Boolean(
    settings?.traktAccessToken && settings.traktRefreshToken
  );
  return {
    provider: 'direct' as const,
    connected,
    username: connected ? (settings?.traktUsername ?? null) : null,
    actionsEnabled,
  };
}

function getAnilistAuthorizeUrl(): string | null {
  try {
    const { clientId } = getAnilistAppCredentials();
    return AnilistAPI.buildAuthorizeUrl(clientId);
  } catch {
    return null;
  }
}

async function getAnilistLinkedAccountPayload(userId: number) {
  const settings = await getUserAnilistSettings(userId);
  const connected = Boolean(
    settings?.anilistAccessToken &&
    !isAnilistTokenExpired(settings.anilistTokenExpiresAt)
  );
  return {
    connected,
    expired: Boolean(
      settings?.anilistAccessToken &&
      isAnilistTokenExpired(settings.anilistTokenExpiresAt)
    ),
    username: connected ? (settings?.anilistUsername ?? null) : null,
    authorizeUrl: getAnilistAuthorizeUrl(),
    actionsEnabled: userActionsEnabled(settings?.mediaActionsAnilistEnabled),
  };
}

async function patchLinkedAccountActions(
  userId: number,
  actorId: number | undefined,
  field: 'mediaActionsTraktEnabled' | 'mediaActionsAnilistEnabled',
  actionsEnabled: unknown
): Promise<{ status: number; message?: string }> {
  if (userId === 1 && actorId !== 1) {
    return {
      status: 403,
      message: "You do not have permission to modify this user's settings.",
    };
  }
  if (typeof actionsEnabled !== 'boolean') {
    return { status: 400, message: 'actionsEnabled must be a boolean.' };
  }
  const userSettings = await ensureUserSettings(userId);
  await getRepository(UserSettings).update(
    { id: userSettings.id },
    { [field]: actionsEnabled }
  );
  return { status: 200 };
}

userSettingsRoutes.get<{ id: string }, UserSettingsGeneralResponse>(
  '/main',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    const {
      main: { defaultQuotas },
    } = getSettings();
    const userRepository = getRepository(User);

    try {
      const user = await userRepository.findOne({
        where: { id: Number(req.params.id) },
        relations: { settings: true },
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      return res.status(200).json({
        username: user.username,
        email: user.email,
        locale: user.settings?.locale,
        discoverRegion: user.settings?.discoverRegion,
        streamingRegion: user.settings?.streamingRegion,
        originalLanguage: user.settings?.originalLanguage,
        movieQuotaLimit: user.movieQuotaLimit,
        movieQuotaDays: user.movieQuotaDays,
        tvQuotaLimit: user.tvQuotaLimit,
        tvQuotaDays: user.tvQuotaDays,
        globalMovieQuotaDays: defaultQuotas.movie.quotaDays,
        globalMovieQuotaLimit: defaultQuotas.movie.quotaLimit,
        globalTvQuotaDays: defaultQuotas.tv.quotaDays,
        globalTvQuotaLimit: defaultQuotas.tv.quotaLimit,
        watchlistSyncMovies: user.settings?.watchlistSyncMovies,
        watchlistSyncTv: user.settings?.watchlistSyncTv,
        autoCompleteSkippedEpisodeEndings:
          user.settings?.autoCompleteSkippedEpisodeEndings,
        autoCompleteSkippedEpisodeThreshold: skippedEpisodeProgressThreshold(
          user.settings?.autoCompleteSkippedEpisodeThreshold
        ),
      });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.post<
  { id: string },
  UserSettingsGeneralResponse,
  UserSettingsGeneralResponse
>('/main', isOwnProfileOrAdmin(), async (req, res, next) => {
  const userRepository = getRepository(User);

  try {
    const user = await userRepository.findOne({
      where: { id: Number(req.params.id) },
      relations: { settings: true },
    });

    if (!user) {
      return next({ status: 404, message: 'User not found.' });
    }

    // "Owner" user settings cannot be modified by other users
    if (user.id === 1 && req.user?.id !== 1) {
      return next({
        status: 403,
        message: "You do not have permission to modify this user's settings.",
      });
    }

    const oldEmail = user.email;
    user.username = req.body.username;
    if (user.userType !== UserType.PLEX) {
      user.email = req.body.email || user.jellyfinUsername || user.email;
    }

    const existingUser = await userRepository.findOne({
      where: { email: user.email, id: Not(user.id) },
    });

    if (oldEmail !== user.email && existingUser) {
      throw new ApiError(400, ApiErrorCode.InvalidEmail);
    }

    // Update quota values only if the user has the correct permissions
    if (
      !user.hasPermission(Permission.MANAGE_USERS) &&
      req.user?.id !== user.id
    ) {
      user.movieQuotaDays = req.body.movieQuotaDays;
      user.movieQuotaLimit = req.body.movieQuotaLimit;
      user.tvQuotaDays = req.body.tvQuotaDays;
      user.tvQuotaLimit = req.body.tvQuotaLimit;
    }

    const skippedEpisodeThreshold = optionalSkippedEpisodeProgressThreshold(
      req.body.autoCompleteSkippedEpisodeThreshold
    );

    if (!user.settings) {
      user.settings = new UserSettings({
        user,
        locale: req.body.locale,
        discoverRegion: req.body.discoverRegion,
        streamingRegion: req.body.streamingRegion,
        originalLanguage: req.body.originalLanguage,
        watchlistSyncMovies: req.body.watchlistSyncMovies,
        watchlistSyncTv: req.body.watchlistSyncTv,
        ...(typeof req.body.autoCompleteSkippedEpisodeEndings === 'boolean'
          ? {
              autoCompleteSkippedEpisodeEndings:
                req.body.autoCompleteSkippedEpisodeEndings,
            }
          : {}),
        ...(skippedEpisodeThreshold !== undefined
          ? { autoCompleteSkippedEpisodeThreshold: skippedEpisodeThreshold }
          : {}),
      });
    } else {
      user.settings.locale = req.body.locale;
      user.settings.discoverRegion = req.body.discoverRegion;
      user.settings.streamingRegion = req.body.streamingRegion;
      user.settings.originalLanguage = req.body.originalLanguage;
      user.settings.watchlistSyncMovies = req.body.watchlistSyncMovies;
      user.settings.watchlistSyncTv = req.body.watchlistSyncTv;
      if (typeof req.body.autoCompleteSkippedEpisodeEndings === 'boolean') {
        user.settings.autoCompleteSkippedEpisodeEndings =
          req.body.autoCompleteSkippedEpisodeEndings;
      }
      if (skippedEpisodeThreshold !== undefined) {
        user.settings.autoCompleteSkippedEpisodeThreshold =
          skippedEpisodeThreshold;
      }
    }

    const savedUser = await userRepository.save(user);

    return res.status(200).json({
      username: savedUser.username,
      locale: savedUser.settings?.locale,
      discoverRegion: savedUser.settings?.discoverRegion,
      streamingRegion: savedUser.settings?.streamingRegion,
      originalLanguage: savedUser.settings?.originalLanguage,
      watchlistSyncMovies: savedUser.settings?.watchlistSyncMovies,
      watchlistSyncTv: savedUser.settings?.watchlistSyncTv,
      autoCompleteSkippedEpisodeEndings:
        savedUser.settings?.autoCompleteSkippedEpisodeEndings,
      autoCompleteSkippedEpisodeThreshold: skippedEpisodeProgressThreshold(
        savedUser.settings?.autoCompleteSkippedEpisodeThreshold
      ),
      email: savedUser.email,
    });
  } catch (e) {
    if (e.errorCode) {
      return next({
        status: e.statusCode,
        message: e.errorCode,
      });
    }
    return next({ status: 500, message: e.message });
  }
});

userSettingsRoutes.get<{ id: string }, { hasPassword: boolean }>(
  '/password',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    const userRepository = getRepository(User);

    try {
      const user = await userRepository.findOne({
        where: { id: Number(req.params.id) },
        select: ['id', 'password'],
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      return res.status(200).json({ hasPassword: !!user.password });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.post<
  { id: string },
  null,
  { currentPassword?: string; newPassword: string }
>('/password', isOwnProfileOrAdmin(), async (req, res, next) => {
  const userRepository = getRepository(User);

  try {
    const user = await userRepository.findOne({
      where: { id: Number(req.params.id) },
    });

    const userWithPassword = await userRepository.findOne({
      select: ['id', 'password'],
      where: { id: Number(req.params.id) },
    });

    if (!user || !userWithPassword) {
      return next({ status: 404, message: 'User not found.' });
    }

    if (req.body.newPassword.length < 8) {
      return next({
        status: 400,
        message: 'Password must be at least 8 characters.',
      });
    }

    if (
      (user.id === 1 && req.user?.id !== 1) ||
      (user.hasPermission(Permission.ADMIN) &&
        user.id !== req.user?.id &&
        req.user?.id !== 1)
    ) {
      return next({
        status: 403,
        message: "You do not have permission to modify this user's password.",
      });
    }

    // If the user has the permission to manage users and they are not
    // editing themselves, we will just set the new password
    if (
      req.user?.hasPermission(Permission.MANAGE_USERS) &&
      req.user?.id !== user.id
    ) {
      await user.setPassword(req.body.newPassword);
      await userRepository.save(user);
      logger.debug('Password overriden by user.', {
        label: 'User Settings',
        userEmail: user.email,
        changingUser: req.user.email,
      });
      return res.status(204).send();
    }

    // If the user has a password, we need to check the currentPassword is correct
    if (
      user.password &&
      (!req.body.currentPassword ||
        !(await userWithPassword.passwordMatch(req.body.currentPassword)))
    ) {
      logger.debug(
        'Attempt to change password for user failed. Invalid current password provided.',
        { label: 'User Settings', userEmail: user.email }
      );
      return next({ status: 403, message: 'Current password is invalid.' });
    }

    await user.setPassword(req.body.newPassword);
    await userRepository.save(user);

    return res.status(204).send();
  } catch (e) {
    next({ status: 500, message: e.message });
  }
});

userSettingsRoutes.post<{ authToken: string }>(
  '/linked-accounts/plex',
  isOwnProfile(),
  async (req, res) => {
    const settings = getSettings();
    const userRepository = getRepository(User);

    if (!req.user) {
      return res.status(404).json({ code: ApiErrorCode.Unauthorized });
    }
    // Make sure Plex login is enabled
    if (settings.main.mediaServerType !== MediaServerType.PLEX) {
      return res.status(500).json({ message: 'Plex login is disabled' });
    }

    // First we need to use this auth token to get the user's email from plex.tv
    const plextv = new PlexTvAPI(req.body.authToken);
    const account = await plextv.getUser();

    // Do not allow linking of an already linked account
    if (await userRepository.exist({ where: { plexId: account.id } })) {
      return res.status(422).json({
        message: 'This Plex account is already linked to a Seerr user',
      });
    }

    const user = req.user;

    // Emails do not match
    if (user.email !== account.email) {
      return res.status(422).json({
        message:
          'This Plex account is registered under a different email address.',
      });
    }

    // valid plex user found, link to current user
    user.userType = UserType.PLEX;
    user.plexId = account.id;
    user.plexUsername = account.username;
    user.plexToken = account.authToken;
    await userRepository.save(user);

    return res.status(204).send();
  }
);

userSettingsRoutes.delete<{ id: string }>(
  '/linked-accounts/plex',
  isOwnProfileOrAdmin(),
  async (req, res) => {
    const settings = getSettings();
    const userRepository = getRepository(User);

    // Make sure Plex login is enabled
    if (settings.main.mediaServerType !== MediaServerType.PLEX) {
      return res.status(500).json({ message: 'Plex login is disabled' });
    }

    try {
      const user = await userRepository
        .createQueryBuilder('user')
        .addSelect('user.password')
        .where({
          id: Number(req.params.id),
        })
        .getOne();

      if (!user) {
        return res.status(404).json({ message: 'User not found.' });
      }

      if (user.id === 1) {
        return res.status(400).json({
          message:
            'Cannot unlink media server accounts for the primary administrator.',
        });
      }

      if (!user.email || !user.password) {
        return res.status(400).json({
          message: 'User does not have a local email or password set.',
        });
      }

      user.userType = UserType.LOCAL;
      user.plexId = null;
      user.plexUsername = null;
      user.plexToken = null;
      await userRepository.save(user);

      return res.status(204).send();
    } catch (e) {
      return res.status(500).json({ message: e.message });
    }
  }
);

userSettingsRoutes.post<{ username: string; password: string }>(
  '/linked-accounts/jellyfin',
  isOwnProfile(),
  async (req, res) => {
    const settings = getSettings();
    const userRepository = getRepository(User);

    if (!req.user) {
      return res.status(401).json({ code: ApiErrorCode.Unauthorized });
    }
    // Make sure jellyfin login is enabled
    if (
      settings.main.mediaServerType !== MediaServerType.JELLYFIN &&
      settings.main.mediaServerType !== MediaServerType.EMBY
    ) {
      return res
        .status(500)
        .json({ message: 'Jellyfin/Emby login is disabled' });
    }

    // Do not allow linking of an already linked account
    if (
      await userRepository.exist({
        where: {
          jellyfinUsername: req.body.username,
          id: Not(req.user.id),
        },
      })
    ) {
      return res.status(422).json({
        message: 'The specified account is already linked to a Seerr user',
      });
    }

    const hostname = getHostname();
    const deviceId = Buffer.from(
      req.user?.id === 1 ? 'BOT_seerr' : `BOT_seerr_${req.user.username ?? ''}`
    ).toString('base64');

    const jellyfinserver = new JellyfinAPI(hostname, undefined, deviceId);

    const ip = req.ip;
    let clientIp: string | undefined;
    if (ip) {
      if (net.isIPv4(ip)) {
        clientIp = ip;
      } else if (net.isIPv6(ip)) {
        clientIp = ip.startsWith('::ffff:') ? ip.substring(7) : ip;
      }
    }

    try {
      const account = await jellyfinserver.login(
        req.body.username,
        req.body.password,
        clientIp
      );

      // Do not allow linking of an already linked account
      if (
        await userRepository.exist({
          where: {
            jellyfinUserId: account.User.Id,
            id: Not(req.user.id),
          },
        })
      ) {
        return res.status(422).json({
          message: 'The specified account is already linked to a Seerr user',
        });
      }

      const user = req.user;

      // valid jellyfin user found, link to current user
      user.userType =
        settings.main.mediaServerType === MediaServerType.EMBY
          ? UserType.EMBY
          : UserType.JELLYFIN;
      user.jellyfinUserId = account.User.Id;
      user.jellyfinUsername = account.User.Name;
      user.jellyfinAuthToken = account.AccessToken;
      user.jellyfinDeviceId = deviceId;
      await userRepository.save(user);

      return res.status(204).send();
    } catch (e) {
      logger.error('Failed to link account to user.', {
        label: 'API',
        ip: req.ip,
        error: e,
      });
      if (
        e instanceof ApiError &&
        e.errorCode === ApiErrorCode.InvalidCredentials
      ) {
        return res.status(401).json({ code: e.errorCode });
      }

      return res.status(500).send();
    }
  }
);

userSettingsRoutes.delete<{ id: string }>(
  '/linked-accounts/jellyfin',
  isOwnProfileOrAdmin(),
  async (req, res) => {
    const settings = getSettings();
    const userRepository = getRepository(User);

    // Make sure jellyfin login is enabled
    if (
      settings.main.mediaServerType !== MediaServerType.JELLYFIN &&
      settings.main.mediaServerType !== MediaServerType.EMBY
    ) {
      return res
        .status(500)
        .json({ message: 'Jellyfin/Emby login is disabled' });
    }

    try {
      const user = await userRepository
        .createQueryBuilder('user')
        .addSelect('user.password')
        .where({
          id: Number(req.params.id),
        })
        .getOne();

      if (!user) {
        return res.status(404).json({ message: 'User not found.' });
      }

      if (user.id === 1) {
        return res.status(400).json({
          message:
            'Cannot unlink media server accounts for the primary administrator.',
        });
      }

      if (!user.email || !user.password) {
        return res.status(400).json({
          message: 'User does not have a local email or password set.',
        });
      }

      user.userType = UserType.LOCAL;
      user.jellyfinUserId = null;
      user.jellyfinUsername = null;
      user.jellyfinAuthToken = null;
      user.jellyfinDeviceId = null;
      await userRepository.save(user);

      return res.status(204).send();
    } catch (e) {
      return res.status(500).json({ message: e.message });
    }
  }
);

userSettingsRoutes.post<{ secret: string }>(
  '/linked-accounts/jellyfin/quickconnect',
  isOwnProfile(),
  async (req, res) => {
    const settings = getSettings();
    const userRepository = getRepository(User);

    if (!req.user) {
      return res.status(401).json({ code: ApiErrorCode.Unauthorized });
    }

    const result = quickConnectSecret.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ message: 'Invalid secret format' });
    }

    const { secret } = result.data;

    if (
      settings.main.mediaServerType !== MediaServerType.JELLYFIN &&
      settings.main.mediaServerType !== MediaServerType.EMBY
    ) {
      return res
        .status(500)
        .json({ message: 'Jellyfin/Emby login is disabled' });
    }

    if (settings.main.mediaServerType !== MediaServerType.JELLYFIN) {
      return res
        .status(403)
        .json({ message: 'Quick Connect is only supported by Jellyfin.' });
    }

    const hostname = getHostname();
    const jellyfinServer = new JellyfinAPI(hostname);

    try {
      const account = await jellyfinServer.authenticateQuickConnect(secret);

      if (
        await userRepository.exist({
          where: {
            jellyfinUserId: account.User.Id,
            id: Not(req.user.id),
          },
        })
      ) {
        return res.status(422).json({
          message: 'The specified account is already linked to a Seerr user',
        });
      }

      const user = req.user;
      const deviceId = Buffer.from(
        user.id === 1 ? 'BOT_seerr' : `BOT_seerr_${user.username ?? ''}`
      ).toString('base64');

      user.userType = UserType.JELLYFIN;
      user.jellyfinUserId = account.User.Id;
      user.jellyfinUsername = account.User.Name;
      user.jellyfinAuthToken = account.AccessToken;
      user.jellyfinDeviceId = deviceId;
      await userRepository.save(user);

      return res.status(204).send();
    } catch (e) {
      logger.error('Failed to link account with Quick Connect.', {
        label: 'API',
        ip: req.ip,
        error: e,
      });

      const status = e instanceof ApiError ? e.statusCode : 500;
      return res.status(status).send();
    }
  }
);

userSettingsRoutes.get<{ id: string }>(
  '/linked-accounts/trakt',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    try {
      const includePluginStatus =
        String(req.query.includePluginStatus) === 'true';
      return res.status(200).json(
        await getTraktLinkedAccountPayload(Number(req.params.id), {
          includePluginStatus,
        })
      );
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.patch<{ id: string }>(
  '/linked-accounts/trakt',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    try {
      const userId = Number(req.params.id);
      const result = await patchLinkedAccountActions(
        userId,
        req.user?.id,
        'mediaActionsTraktEnabled',
        req.body.actionsEnabled
      );
      if (result.status !== 200) {
        return next(result);
      }
      return res.status(200).json(await getTraktLinkedAccountPayload(userId));
    } catch (e) {
      if (e instanceof Error && e.message === 'User not found') {
        return next({ status: 404, message: e.message });
      }
      next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.get<{ id: string }, DiscoverFilterDefaults>(
  '/discover',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    try {
      const userSettings = await ensureUserSettings(Number(req.params.id));
      return res.status(200).json(userSettings.discoverFilterDefaults ?? {});
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.post<
  { id: string },
  DiscoverFilterDefaults,
  DiscoverFilterDefaults
>('/discover', isOwnProfileOrAdmin(), async (req, res, next) => {
  try {
    const userRepository = getRepository(User);
    const user = await userRepository.findOne({
      where: { id: Number(req.params.id) },
    });

    if (!user) {
      return next({ status: 404, message: 'User not found.' });
    }

    if (user.id === 1 && req.user?.id !== 1) {
      return next({
        status: 403,
        message: "You do not have permission to modify this user's settings.",
      });
    }

    let parsed: DiscoverFilterDefaults;
    try {
      parsed = parseDiscoverFilterDefaults(req.body ?? {});
    } catch {
      return next({
        status: 400,
        message: 'Invalid discover filter defaults.',
      });
    }

    const userSettings = await ensureUserSettings(Number(req.params.id));
    userSettings.discoverFilterDefaults = parsed;
    await getRepository(UserSettings).save(userSettings);

    return res.status(200).json(userSettings.discoverFilterDefaults ?? {});
  } catch (e) {
    next({ status: 500, message: e.message });
  }
});

userSettingsRoutes.post<{ id: string }>(
  '/linked-accounts/trakt/device/code',
  isOwnProfile(),
  traktDeviceCodeCreationLimiter,
  async (req, res) => {
    try {
      if (isJellyfinTraktProvider()) {
        return res.status(409).json({
          message:
            'Trakt is provided by Better Trakt through Jellyfin. Link Trakt in Jellyfin instead.',
        });
      }
      const trakt = createTraktAppClient();
      const deviceCode = await trakt.requestDeviceCode();
      rememberTraktDeviceAuthSession(
        Number(req.params.id),
        deviceCode.device_code,
        deviceCode.interval,
        deviceCode.expires_in
      );
      return res.status(200).json(deviceCode);
    } catch (e) {
      if (e instanceof TraktNotConfiguredError) {
        return res.status(400).json({ message: e.message });
      }
      logger.error('Failed to start Trakt device auth', {
        label: 'API',
        errorMessage: e instanceof Error ? e.message : 'unknown error',
      });
      return res.status(500).json({
        message: 'Unable to start Trakt device authorization.',
      });
    }
  }
);

userSettingsRoutes.post<{ id: string }>(
  '/linked-accounts/trakt/device/token',
  isOwnProfile(),
  traktDevicePollLimiter,
  enforceTraktDevicePollInterval,
  async (req, res) => {
    try {
      if (isJellyfinTraktProvider()) {
        return res.status(409).json({
          message:
            'Trakt is provided by Better Trakt through Jellyfin. Link Trakt in Jellyfin instead.',
        });
      }
      const deviceCode = String(req.body.deviceCode ?? '').trim();
      if (!deviceCode) {
        return res.status(400).json({ message: 'deviceCode is required' });
      }

      const trakt = createTraktAppClient();
      const result = await trakt.pollForToken(deviceCode);

      if (result.status === 'pending') {
        return res.status(202).json({ status: 'pending' });
      }
      if (result.status === 'slow_down') {
        noteTraktDevicePollSlowDown(Number(req.params.id), deviceCode);
        return res.status(202).json({
          status: 'pending',
          retryAfterSeconds: TRAKT_DEVICE_SLOW_DOWN_SECONDS,
        });
      }
      if (result.status === 'invalid') {
        return res.status(400).json({ status: 'invalid' });
      }
      if (result.status === 'already_used') {
        return res.status(409).json({ status: 'already_used' });
      }
      if (result.status === 'expired') {
        return res.status(410).json({ status: 'expired' });
      }
      if (result.status === 'denied') {
        return res.status(409).json({ status: 'denied' });
      }

      const traktSettings = getSettings().trakt;
      const authenticated = new TraktAPI({
        clientId: traktSettings.clientId,
        clientSecret: traktSettings.clientSecret,
        accessToken: result.tokens.access_token,
        refreshToken: result.tokens.refresh_token,
        expiresAt: result.tokens.expiresAt,
      });
      const profile = await authenticated.getUserSettings();
      const foreseerrUserId = Number(req.params.id);

      await assertTraktAccountAvailable(profile.traktUserId, foreseerrUserId);

      const userSettings = await ensureUserSettings(foreseerrUserId);
      userSettings.traktAccessToken = result.tokens.access_token;
      userSettings.traktRefreshToken = result.tokens.refresh_token;
      userSettings.traktTokenExpiresAt = String(result.tokens.expiresAt);
      userSettings.traktUsername = profile.username;
      userSettings.traktUserId = profile.traktUserId;
      await getRepository(UserSettings).save(userSettings);
      invalidateUserSyncCache(foreseerrUserId);
      clearTraktDeviceAuthSession(foreseerrUserId, deviceCode);

      return res.status(200).json({
        status: 'authorized',
        username: profile.username,
      });
    } catch (e) {
      if (e instanceof TraktAccountAlreadyLinkedError) {
        return res.status(409).json({ message: e.message });
      }
      if (e instanceof TraktNotConfiguredError) {
        return res.status(400).json({ message: e.message });
      }
      logger.error('Failed to complete Trakt device auth', {
        label: 'API',
        errorMessage: e instanceof Error ? e.message : 'unknown error',
      });
      return res.status(500).json({
        message: 'Unable to complete Trakt device authorization.',
      });
    }
  }
);

userSettingsRoutes.delete<{ id: string }>(
  '/linked-accounts/trakt',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    try {
      if (isJellyfinTraktProvider()) {
        return res.status(409).json({
          message:
            'Trakt is provided by Better Trakt through Jellyfin. Unlink it from Jellyfin instead.',
        });
      }
      const foreseerrUserId = Number(req.params.id);
      const userSettings = await getUserTraktSettings(foreseerrUserId);
      if (!userSettings) {
        return res.status(204).send();
      }

      await clearUserTraktCredentials(userSettings.id, foreseerrUserId);

      return res.status(204).send();
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.get<{ id: string }>(
  '/linked-accounts/anilist',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    try {
      return res
        .status(200)
        .json(await getAnilistLinkedAccountPayload(Number(req.params.id)));
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.patch<{ id: string }>(
  '/linked-accounts/anilist',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    try {
      const userId = Number(req.params.id);
      const result = await patchLinkedAccountActions(
        userId,
        req.user?.id,
        'mediaActionsAnilistEnabled',
        req.body.actionsEnabled
      );
      if (result.status !== 200) {
        return next(result);
      }
      return res.status(200).json(await getAnilistLinkedAccountPayload(userId));
    } catch (e) {
      if (e instanceof Error && e.message === 'User not found') {
        return next({ status: 404, message: e.message });
      }
      next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.post<{ id: string }>(
  '/linked-accounts/anilist',
  isOwnProfile(),
  async (req, res) => {
    try {
      const { clientId, clientSecret } = getAnilistAppCredentials();
      const code = String(req.body.code ?? '').trim();
      if (!code) {
        return res.status(400).json({ message: 'code is required' });
      }

      const tokens = await AnilistAPI.exchangePinCode(
        clientId,
        clientSecret,
        code
      );
      const authenticated = new AnilistAPI({
        accessToken: tokens.accessToken,
      });
      const viewer = await authenticated.getViewer();
      const foreseerrUserId = Number(req.params.id);
      const anilistUserId = String(viewer.id);

      await assertAnilistAccountAvailable(anilistUserId, foreseerrUserId);

      const userSettings = await ensureUserSettings(foreseerrUserId);
      userSettings.anilistAccessToken = tokens.accessToken;
      userSettings.anilistTokenExpiresAt = String(tokens.expiresAt);
      userSettings.anilistUsername = viewer.name;
      userSettings.anilistUserId = anilistUserId;
      await getRepository(UserSettings).save(userSettings);
      invalidateUserAnilistSyncCache(foreseerrUserId);

      return res.status(200).json({
        status: 'authorized',
        username: viewer.name,
      });
    } catch (e) {
      if (e instanceof AnilistAccountAlreadyLinkedError) {
        return res.status(409).json({ message: e.message });
      }
      if (e instanceof AnilistNotConfiguredError) {
        return res.status(400).json({ message: e.message });
      }
      logger.error('Failed to complete AniList authorization', {
        label: 'API',
        errorMessage: e instanceof Error ? e.message : 'unknown error',
      });
      return res.status(500).json({
        message: 'Unable to complete AniList authorization.',
      });
    }
  }
);

userSettingsRoutes.delete<{ id: string }>(
  '/linked-accounts/anilist',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    try {
      const foreseerrUserId = Number(req.params.id);
      const userSettings = await getUserAnilistSettings(foreseerrUserId);
      if (!userSettings) {
        return res.status(204).send();
      }

      await clearUserAnilistCredentials(userSettings.id, foreseerrUserId);

      return res.status(204).send();
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.get<{ id: string }, UserSettingsNotificationsResponse>(
  '/notifications',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    const userRepository = getRepository(User);
    const settings = getSettings()?.notifications.agents;

    try {
      const user = await userRepository.findOne({
        where: { id: Number(req.params.id) },
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      return res.status(200).json({
        emailEnabled: settings.email.enabled,
        pgpKey: user.settings?.pgpKey,
        discordEnabled:
          settings?.discord.enabled && settings.discord.options.enableMentions,
        discordEnabledTypes:
          settings?.discord.enabled && settings.discord.options.enableMentions
            ? settings.discord.types
            : 0,
        discordIds: user.settings?.discordIds ?? [],
        pushbulletAccessToken: user.settings?.pushbulletAccessToken,
        pushoverApplicationToken: user.settings?.pushoverApplicationToken,
        pushoverUserKey: user.settings?.pushoverUserKey,
        pushoverSound: user.settings?.pushoverSound,
        telegramEnabled: settings.telegram.enabled,
        telegramBotUsername: settings.telegram.options.botUsername,
        telegramChatId: user.settings?.telegramChatId,
        telegramMessageThreadId: user.settings?.telegramMessageThreadId,
        telegramSendSilently: user.settings?.telegramSendSilently,
        webPushEnabled: settings.webpush.enabled,
        notificationTypes: user.settings?.notificationTypes ?? {},
      });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.post<{ id: string }, UserSettingsNotificationsResponse>(
  '/notifications',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    const userRepository = getRepository(User);

    try {
      const user = await userRepository.findOne({
        where: { id: Number(req.params.id) },
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      // "Owner" user settings cannot be modified by other users
      if (user.id === 1 && req.user?.id !== 1) {
        return next({
          status: 403,
          message: "You do not have permission to modify this user's settings.",
        });
      }

      const discordIds =
        req.body.discordIds?.filter((id: string) => id !== '') ?? [];

      if (!user.settings) {
        user.settings = new UserSettings({
          user: req.user,
          pgpKey: req.body.pgpKey,
          discordIds,
          pushbulletAccessToken: req.body.pushbulletAccessToken,
          pushoverApplicationToken: req.body.pushoverApplicationToken,
          pushoverUserKey: req.body.pushoverUserKey,
          telegramChatId: req.body.telegramChatId,
          telegramMessageThreadId: req.body.telegramMessageThreadId,
          telegramSendSilently: req.body.telegramSendSilently,
          notificationTypes: req.body.notificationTypes,
        });
      } else {
        user.settings.pgpKey = req.body.pgpKey;
        user.settings.discordIds = discordIds;
        user.settings.pushbulletAccessToken = req.body.pushbulletAccessToken;
        user.settings.pushoverApplicationToken =
          req.body.pushoverApplicationToken;
        user.settings.pushoverUserKey = req.body.pushoverUserKey;
        user.settings.pushoverSound = req.body.pushoverSound;
        user.settings.telegramChatId = req.body.telegramChatId;
        user.settings.telegramMessageThreadId =
          req.body.telegramMessageThreadId;
        user.settings.telegramSendSilently = req.body.telegramSendSilently;
        user.settings.notificationTypes = Object.assign(
          {},
          user.settings.notificationTypes,
          req.body.notificationTypes
        );
      }

      await userRepository.save(user);

      return res.status(200).json({
        pgpKey: user.settings.pgpKey,
        discordIds: user.settings.discordIds ?? [],
        pushbulletAccessToken: user.settings.pushbulletAccessToken,
        pushoverApplicationToken: user.settings.pushoverApplicationToken,
        pushoverUserKey: user.settings.pushoverUserKey,
        pushoverSound: user.settings.pushoverSound,
        telegramChatId: user.settings.telegramChatId,
        telegramMessageThreadId: user.settings.telegramMessageThreadId,
        telegramSendSilently: user.settings.telegramSendSilently,
        notificationTypes: user.settings.notificationTypes,
      });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.get<{ id: string }, { permissions?: number }>(
  '/permissions',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    const userRepository = getRepository(User);

    try {
      const user = await userRepository.findOne({
        where: { id: Number(req.params.id) },
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      return res.status(200).json({ permissions: user.permissions });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.post<
  { id: string },
  { permissions?: number },
  { permissions: number }
>(
  '/permissions',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    const userRepository = getRepository(User);

    try {
      const user = await userRepository.findOne({
        where: { id: Number(req.params.id) },
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      // "Owner" user permissions cannot be modified, and users cannot set their own permissions
      if (user.id === 1 || req.user?.id === user.id) {
        return next({
          status: 403,
          message: 'You do not have permission to modify this user',
        });
      }

      if (!canMakePermissionsChange(req.body.permissions, req.user)) {
        return next({
          status: 403,
          message: 'You do not have permission to grant this level of access',
        });
      }
      user.permissions = req.body.permissions;

      await userRepository.save(user);

      return res.status(200).json({ permissions: user.permissions });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

export default userSettingsRoutes;
