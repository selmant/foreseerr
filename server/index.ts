import csurf from '@dr.pogodin/csurf';
import PlexAPI from '@server/api/plexapi';
import dataSource, { getRepository, isPgsql } from '@server/datasource';
import DiscoverSlider from '@server/entity/DiscoverSlider';
import { Session } from '@server/entity/Session';
import { User } from '@server/entity/User';
import { initI18n } from '@server/i18n';
import { startDesktopCatchUp, startJobs, stopJobs } from '@server/job/schedule';
import { assertSupportedDatabaseSchema } from '@server/lib/db/schemaGuard';
import {
  DESKTOP_SCHEMA_EXIT_CODE,
  acquireDesktopLock,
  desktopError,
} from '@server/lib/desktopRuntime';
import { setDesktopPlaybackActive } from '@server/lib/desktopState';
import ImageProxy from '@server/lib/imageproxy';
import notificationManager from '@server/lib/notifications';
import DiscordAgent from '@server/lib/notifications/agents/discord';
import EmailAgent from '@server/lib/notifications/agents/email';
import GotifyAgent from '@server/lib/notifications/agents/gotify';
import NtfyAgent from '@server/lib/notifications/agents/ntfy';
import PushbulletAgent from '@server/lib/notifications/agents/pushbullet';
import PushoverAgent from '@server/lib/notifications/agents/pushover';
import SlackAgent from '@server/lib/notifications/agents/slack';
import TelegramAgent from '@server/lib/notifications/agents/telegram';
import WebhookAgent from '@server/lib/notifications/agents/webhook';
import WebPushAgent from '@server/lib/notifications/agents/webpush';
import checkOverseerrMerge from '@server/lib/overseerrMerge';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import clearCookies from '@server/middleware/clearcookies';
import routes from '@server/routes';
import avatarproxy from '@server/routes/avatarproxy';
import imageproxy from '@server/routes/imageproxy';
import { appDataPermissions } from '@server/utils/appDataVolume';
import { getAppVersion } from '@server/utils/appVersion';
import createCustomProxyAgent, {
  setForceIpv4First,
} from '@server/utils/customProxyAgent';
import { initializeDnsCache } from '@server/utils/dnsCache';
import restartFlag from '@server/utils/restartFlag';
import { getClientIp } from '@supercharge/request-ip';
import { TypeormStore } from 'connect-typeorm/out';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import type { Store } from 'express-session';
import session from 'express-session';
import fs from 'fs/promises';
import type { Server as HttpServer } from 'http';
import yaml from 'js-yaml';
import next from 'next';
import path from 'path';
import swaggerUi from 'swagger-ui-express';

const API_SPEC_PATH = path.join(__dirname, '../seerr-api.yml');

logger.info(`Starting Seerr version ${getAppVersion()}`);
const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();
const desktopRuntime = process.env.FORESEERR_RUNTIME === 'desktop';
let managedServer: HttpServer | undefined;
let releaseDesktopLock: (() => Promise<void>) | undefined;
let stopping = false;
let desktopOrigin = '';

const stopManagedRuntime = async (deadlineMs = 10_000): Promise<void> => {
  if (stopping) return;
  stopping = true;
  stopJobs();
  const server = managedServer;
  if (server) {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        server.closeAllConnections();
        resolve();
      }, deadlineMs);
      server.close(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  if (dataSource.isInitialized) {
    if (!isPgsql) {
      await dataSource
        .query('PRAGMA wal_checkpoint(TRUNCATE)')
        .catch(() => undefined);
    }
    await dataSource.destroy();
  }
  await releaseDesktopLock?.();
  releaseDesktopLock = undefined;
};

const requestManagedShutdown = (deadlineMs = 10_000): void => {
  void stopManagedRuntime(deadlineMs).finally(() => process.exit(0));
};

if (desktopRuntime) {
  process.stdin.setEncoding('utf8');
  let input = '';
  process.stdin.on('data', (chunk: string) => {
    input += chunk;
    const lines = input.split('\n');
    input = lines.pop() ?? '';
    for (const line of lines) {
      try {
        const message = JSON.parse(line) as {
          type?: string;
          deadlineMs?: number;
          playbackActive?: boolean;
        };
        if (message.type === 'shutdown') {
          requestManagedShutdown(message.deadlineMs);
        } else if (
          message.type === 'runtime-state' &&
          typeof message.playbackActive === 'boolean'
        ) {
          setDesktopPlaybackActive(message.playbackActive);
          if (!message.playbackActive) startDesktopCatchUp();
        } else {
          logger.warn('Ignoring unknown desktop control message', {
            label: 'Desktop',
          });
        }
      } catch {
        logger.warn('Ignoring malformed desktop control message', {
          label: 'Desktop',
        });
      }
    }
  });
  process.stdin.on('end', () => requestManagedShutdown());
  process.once('SIGTERM', () => requestManagedShutdown());
  process.once('SIGINT', () => requestManagedShutdown());
}

if (!appDataPermissions()) {
  logger.error(
    'Something went wrong while checking config folder! Please ensure the config folder is set up properly.\nhttps://selmant.github.io/foreseerr/getting-started/'
  );
}

app
  .prepare()
  .then(async () => {
    if (desktopRuntime) {
      releaseDesktopLock = await acquireDesktopLock();
    }
    // Run Overseerr to Seerr migration
    await checkOverseerrMerge();

    const dbConnection = dataSource.isInitialized
      ? dataSource
      : await dataSource.initialize();

    // Run migrations in production
    if (process.env.NODE_ENV === 'production') {
      if (isPgsql) {
        await dbConnection.runMigrations();
      } else {
        await dbConnection.query('PRAGMA foreign_keys=OFF');
        await dbConnection.runMigrations();
        await dbConnection.query('PRAGMA foreign_keys=ON');
      }
    }

    // Refuse to start against a database migrated by a newer, unrecognized
    // Foreseerr version instead of silently running against an unknown
    // schema. Checked unconditionally (not just in production) since a
    // downgraded dev/synchronize install could still point at such a DB.
    try {
      await assertSupportedDatabaseSchema(dbConnection);
    } catch (error) {
      if (desktopRuntime) {
        await releaseDesktopLock?.();
        releaseDesktopLock = undefined;
        throw desktopError(
          `Desktop database schema is incompatible: ${(error as Error).message}`,
          DESKTOP_SCHEMA_EXIT_CODE
        );
      }
      throw error;
    }

    // Load Settings
    const settings = await getSettings().load();
    restartFlag.initializeSettings(settings);

    initI18n();

    setForceIpv4First(settings.network.forceIpv4First);

    // Add DNS caching
    if (settings.network.dnsCache?.enabled) {
      initializeDnsCache({
        forceMinTtl: settings.network.dnsCache.forceMinTtl,
        forceMaxTtl: settings.network.dnsCache.forceMaxTtl,
      });
    }

    // Register HTTP proxy
    if (settings.network.proxy.enabled) {
      await createCustomProxyAgent(
        settings.network.proxy,
        settings.network.forceIpv4First
      );
    }

    // Migrate library types
    if (
      settings.plex.libraries.length > 1 &&
      !settings.plex.libraries[0].type
    ) {
      const userRepository = getRepository(User);
      const admin = await userRepository.findOne({
        select: { id: true, plexToken: true },
        where: { id: 1 },
      });

      if (admin) {
        logger.info('Migrating Plex libraries to include media type', {
          label: 'Settings',
        });

        const plexapi = new PlexAPI({ plexToken: admin.plexToken });
        await plexapi.syncLibraries();
      }
    }

    // Register Notification Agents
    notificationManager.registerAgents([
      new DiscordAgent(),
      new EmailAgent(),
      new GotifyAgent(),
      new NtfyAgent(),
      new PushbulletAgent(),
      new PushoverAgent(),
      new SlackAgent(),
      new TelegramAgent(),
      new WebhookAgent(),
      new WebPushAgent(),
    ]);

    const userRepository = getRepository(User);
    const totalUsers = await userRepository.count();
    if (totalUsers > 0) {
      startJobs();
      startDesktopCatchUp();
    } else {
      logger.info(
        `Skipping starting the scheduled jobs as we have no Plex/Jellyfin/Emby servers setup yet`,
        {
          label: 'Server',
        }
      );
    }

    // Bootstrap Discovery Sliders
    await DiscoverSlider.bootstrapSliders();

    // Prune expired and malformed transient image entries before accepting
    // requests. Failures are contained inside the cache layer and must never
    // prevent the durable application runtime from starting.
    await ImageProxy.maintainCache();

    const server = express();
    if (!desktopRuntime && settings.network.trustProxy) {
      server.enable('trust proxy');
    }
    if (desktopRuntime) {
      server.use((req, res, next) => {
        const unsafeMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(
          req.method
        );
        const nativeTicket = req.path === '/api/v1/desktop/auth-tickets/redeem';
        if (
          (stopping && req.path !== '/api/v1/status') ||
          !desktopOrigin ||
          req.headers.host !== desktopOrigin.replace('http://', '') ||
          req.headers['x-forwarded-host'] ||
          req.headers.forwarded ||
          req.originalUrl.startsWith('http://') ||
          req.originalUrl.startsWith('https://') ||
          (unsafeMethod &&
            !nativeTicket &&
            req.headers.origin !== desktopOrigin)
        ) {
          res.status(stopping ? 503 : 403).json({
            message: stopping
              ? 'Foreseerr is shutting down'
              : 'Invalid local desktop request',
          });
          return;
        }
        next();
      });
    }
    server.use(cookieParser());
    server.use(express.json());
    server.use(express.urlencoded({ extended: true }));
    server.use((req, _res, next) => {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(req, 'ip');
        if (descriptor?.writable === true) {
          Object.defineProperty(req, 'ip', {
            ...descriptor,
            value: getClientIp(req) ?? '',
          });
        }
      } catch (e) {
        logger.error('Failed to attach the ip to the request', {
          label: 'Middleware',
          message: (e as Error).message,
        });
      } finally {
        next();
      }
    });
    if (desktopRuntime || settings.network.csrfProtection) {
      server.use(
        csurf({
          cookie: {
            httpOnly: true,
            sameSite: desktopRuntime ? 'strict' : true,
            secure: desktopRuntime ? false : !dev,
            key: '_csrf',
            path: '/',
          },
          // Native hosts redeem with ticket+verifier and no browser cookies.
          ignoreRequest: (req) =>
            req.method === 'POST' &&
            req.path === '/api/v1/desktop/auth-tickets/redeem',
        })
      );
      server.use((req, res, next) => {
        res.cookie('XSRF-TOKEN', req.csrfToken(), {
          sameSite: desktopRuntime ? 'strict' : true,
          secure: desktopRuntime ? false : !dev,
        });
        next();
      });
    }

    // Set up sessions
    const sessionRespository = getRepository(Session);
    server.use(
      '/api',
      session({
        secret: settings.sessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: {
          maxAge: 1000 * 60 * 60 * 24 * 30,
          httpOnly: true,
          sameSite:
            desktopRuntime || settings.network.csrfProtection
              ? 'strict'
              : 'lax',
          secure: desktopRuntime ? false : 'auto',
        },
        store: new TypeormStore({
          cleanupLimit: 2,
          ttl: 60 * 60 * 24 * 30,
        }).connect(sessionRespository) as Store,
      })
    );
    const apiSpecContent = await fs.readFile(API_SPEC_PATH, 'utf-8');
    const apiDocs = yaml.load(apiSpecContent) as Record<string, unknown>;
    server.use('/api-docs', swaggerUi.serve, swaggerUi.setup(apiDocs));
    server.use(
      OpenApiValidator.middleware({
        apiSpec: API_SPEC_PATH,
        validateRequests: true,
      })
    );
    /**
     * This is a workaround to convert dates to strings before they are validated by
     * OpenAPI validator. Otherwise, they are treated as objects instead of strings
     * and response validation will fail
     */
    server.use((_req, res, next) => {
      const original = res.json;
      res.json = function jsonp(json) {
        return original.call(this, JSON.parse(JSON.stringify(json)));
      };
      next();
    });
    server.use('/api/v1', routes);

    // Do not set cookies so CDNs can cache them
    server.use('/imageproxy', clearCookies, imageproxy);
    server.use('/avatarproxy', clearCookies, avatarproxy);

    server.get('*path', (req, res) => handle(req, res));
    server.use(
      (
        err: {
          status: number;
          message: string;
          errors: string[];
          retryAfter?: number;
        },
        _req: Request,
        res: Response,
        // We must provide a next function for the function signature here even though its not used
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _next: NextFunction
      ) => {
        // format error
        if (
          err.status === 429 &&
          typeof err.retryAfter === 'number' &&
          Number.isFinite(err.retryAfter)
        ) {
          res.setHeader('Retry-After', String(Math.ceil(err.retryAfter)));
        }
        res.status(err.status || 500).json({
          message: err.message,
          errors: err.errors,
        });
      }
    );

    const configuredPort = Number(process.env.PORT);
    const port =
      Number.isInteger(configuredPort) && configuredPort >= 0
        ? configuredPort
        : 5055;
    const host = desktopRuntime ? '127.0.0.1' : process.env.HOST;
    let httpServer: HttpServer;
    if (host) {
      httpServer = server.listen(port, host, () => {
        logger.info(`Server ready on ${host} port ${port}`, {
          label: 'Server',
        });
      });
    } else {
      httpServer = server.listen(port, () => {
        logger.info(`Server ready on port ${port}`, {
          label: 'Server',
        });
      });
    }
    httpServer.on('error', (err) => {
      logger.error('Failed to start server', {
        label: 'Server',
        message: err.message,
      });
      process.exit(1);
    });
    managedServer = httpServer;
    if (desktopRuntime) {
      httpServer.on('listening', () => {
        const address = httpServer.address();
        if (
          typeof address !== 'object' ||
          !address ||
          address.address !== '127.0.0.1'
        ) {
          logger.error('Desktop runtime did not bind exact loopback', {
            label: 'Desktop',
          });
          requestManagedShutdown();
          return;
        }
        desktopOrigin = `http://127.0.0.1:${address.port}`;
        process.stdout.write(
          `FORESEERR_DESKTOP_READY ${JSON.stringify({ protocolVersion: 1, pid: process.pid, origin: desktopOrigin, foreseerrVersion: getAppVersion(), commit: process.env.FORESEERR_COMMIT ?? 'unknown', schemaVersion: 0 })}\n`
        );
      });
    }
  })
  .catch(async (err) => {
    logger.error(err.stack);
    await releaseDesktopLock?.();
    releaseDesktopLock = undefined;
    process.exit(err.exitCode ?? 1);
  });
