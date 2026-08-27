import AnilistAPI from '@server/api/anilist';
import MdblistAPI from '@server/api/mdblist';
import SimklAPI from '@server/api/simkl';
import TraktAPI from '@server/api/trakt';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { mapWithConcurrency } from '@server/lib/concurrency';
import { getSettings } from '@server/lib/settings';
import {
  resolveJellyfinTraktUserState,
  type JellyfinTraktUserState,
} from '@server/lib/trakt';
import logger from '@server/logger';
import { getHostname } from '@server/utils/getHostname';
import axios from 'axios';

const HEALTH_CHECK_TTL_MS = 5 * 60 * 1000;

export type IntegrationHealthState = 'not_configured' | 'healthy' | 'degraded';

export interface IntegrationHealth {
  state: IntegrationHealthState;
  detail: string;
  checkedAt: string | null;
}

export type { JellyfinTraktUserState };

export interface JellyfinTraktUserReadiness {
  userId: number;
  displayName: string;
  state: JellyfinTraktUserState;
}

export interface JellyfinTraktReadiness {
  eligibleUsers: number;
  readyUsers: number;
  users: JellyfinTraktUserReadiness[];
}

export interface TraktIntegrationHealth extends IntegrationHealth {
  provider: 'direct' | 'jellyfin';
  direct: IntegrationHealth;
  jellyfin: IntegrationHealth & { readiness: JellyfinTraktReadiness };
}

export interface IntegrationHealthResponse {
  trakt: TraktIntegrationHealth;
  mdblist: IntegrationHealth;
  anilist: IntegrationHealth;
  simkl: IntegrationHealth;
}

let cachedHealth: {
  value: IntegrationHealthResponse;
  expiresAt: number;
} | null = null;

export const clearIntegrationHealthCache = (): void => {
  cachedHealth = null;
};

const healthy = (detail: string): IntegrationHealth => ({
  state: 'healthy',
  detail,
  checkedAt: new Date().toISOString(),
});

const degraded = (detail: string): IntegrationHealth => ({
  state: 'degraded',
  detail,
  checkedAt: new Date().toISOString(),
});

const notConfigured = (detail: string): IntegrationHealth => ({
  state: 'not_configured',
  detail,
  checkedAt: null,
});

const checkDirectTrakt = async (): Promise<IntegrationHealth> => {
  const settings = getSettings();
  if (settings.trakt.provider === 'jellyfin') {
    return notConfigured('Direct Trakt is not the active connection method.');
  }
  if (!settings.trakt.clientId || !settings.trakt.clientSecret) {
    return notConfigured('Trakt application credentials are not configured.');
  }

  try {
    await new TraktAPI({
      clientId: settings.trakt.clientId,
      clientSecret: settings.trakt.clientSecret,
    }).validateApplicationCredentials();
    return healthy('Trakt is reachable and the Client ID was accepted.');
  } catch {
    return degraded('Trakt could not accept the saved application settings.');
  }
};

const emptyJellyfinReadiness = (): JellyfinTraktReadiness => ({
  eligibleUsers: 0,
  readyUsers: 0,
  users: [],
});

const checkJellyfinUserReadiness = async (
  user: User
): Promise<JellyfinTraktUserReadiness> => ({
  userId: user.id,
  displayName: user.displayName,
  state: await resolveJellyfinTraktUserState(user),
});

const checkJellyfinTrakt = async (): Promise<
  IntegrationHealth & { readiness: JellyfinTraktReadiness }
> => {
  const settings = getSettings();
  if (!settings.jellyfin.ip) {
    return {
      ...notConfigured('Jellyfin is not configured.'),
      readiness: emptyJellyfinReadiness(),
    };
  }

  try {
    const users = await getRepository(User)
      .createQueryBuilder('user')
      .addSelect('user.jellyfinAuthToken')
      .addSelect('user.jellyfinDeviceId')
      .where('user.jellyfinUserId IS NOT NULL')
      .getMany();

    if (users.length === 0) {
      try {
        await axios.get(`${getHostname()}/System/Info/Public`, {
          timeout: 5000,
        });
        return {
          ...degraded(
            'Jellyfin is reachable, but no Foreseer users are linked to Jellyfin.'
          ),
          readiness: emptyJellyfinReadiness(),
        };
      } catch (e) {
        logger.warn('Better Trakt health check could not reach Jellyfin', {
          label: 'Integration Health',
          hostname: getHostname(),
          errorMessage: e instanceof Error ? e.message : 'unknown error',
        });
        return {
          ...degraded(`Foreseer could not reach Jellyfin at ${getHostname()}.`),
          readiness: emptyJellyfinReadiness(),
        };
      }
    }

    const userReadiness = await mapWithConcurrency(
      users,
      4,
      checkJellyfinUserReadiness
    );
    const readiness: JellyfinTraktReadiness = {
      eligibleUsers: userReadiness.length,
      readyUsers: userReadiness.filter((user) => user.state === 'ready').length,
      users: userReadiness,
    };

    if (readiness.readyUsers !== readiness.eligibleUsers) {
      return {
        ...degraded(
          `${readiness.readyUsers} of ${readiness.eligibleUsers} users are ready for Better Trakt.`
        ),
        readiness,
      };
    }
    return {
      ...healthy(
        `Jellyfin and Better Trakt are ready for all ${readiness.readyUsers} linked users.`
      ),
      readiness,
    };
  } catch (e) {
    logger.warn('Better Trakt health check failed', {
      label: 'Integration Health',
      hostname: getHostname(),
      errorMessage: e instanceof Error ? e.message : 'unknown error',
    });
    return {
      ...degraded('Better Trakt could not be checked through Jellyfin.'),
      readiness: emptyJellyfinReadiness(),
    };
  }
};

const checkMdblist = async (): Promise<IntegrationHealth> => {
  if (!getSettings().mdblist.apiKey?.trim()) {
    return notConfigured('MDBList API key is not configured.');
  }

  try {
    await MdblistAPI.getInstance().validateApiKey();
    return healthy('MDBList API key is valid and the service is reachable.');
  } catch {
    return degraded('MDBList could not validate the saved API key.');
  }
};

const checkAnilist = async (): Promise<IntegrationHealth> => {
  if (
    !getSettings().anilist.clientId?.trim() ||
    !getSettings().anilist.clientSecret?.trim()
  ) {
    return notConfigured('AniList application credentials are not configured.');
  }

  try {
    await new AnilistAPI().ping();
    return healthy('AniList GraphQL API is reachable.');
  } catch (e) {
    logger.warn('AniList health check failed', {
      label: 'Integration Health',
      errorMessage: e instanceof Error ? e.message : 'unknown error',
    });
    return degraded('AniList GraphQL API could not be reached.');
  }
};

const checkSimkl = async (): Promise<IntegrationHealth> => {
  if (!getSettings().simkl.clientId.trim()) {
    return notConfigured('Simkl Client ID is not configured.');
  }
  try {
    await new SimklAPI().validateClientId();
    return healthy('Simkl is reachable and the Client ID was accepted.');
  } catch {
    return degraded('Simkl could not accept the saved Client ID.');
  }
};

export const getIntegrationHealth =
  async (): Promise<IntegrationHealthResponse> => {
    if (cachedHealth && cachedHealth.expiresAt > Date.now()) {
      return cachedHealth.value;
    }

    const provider =
      getSettings().trakt.provider === 'jellyfin' ? 'jellyfin' : 'direct';
    const [direct, jellyfin, mdblist, anilist, simkl] = await Promise.all([
      checkDirectTrakt(),
      checkJellyfinTrakt(),
      checkMdblist(),
      checkAnilist(),
      checkSimkl(),
    ]);
    const active = provider === 'jellyfin' ? jellyfin : direct;
    const value: IntegrationHealthResponse = {
      trakt: { provider, ...active, direct, jellyfin },
      mdblist,
      anilist,
      simkl,
    };

    cachedHealth = { value, expiresAt: Date.now() + HEALTH_CHECK_TTL_MS };
    return value;
  };
