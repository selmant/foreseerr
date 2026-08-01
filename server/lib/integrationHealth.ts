import JellyfinAPI from '@server/api/jellyfin';
import MdblistAPI from '@server/api/mdblist';
import TraktAPI from '@server/api/trakt';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { mapWithConcurrency } from '@server/lib/concurrency';
import { getSettings } from '@server/lib/settings';
import { getHostname } from '@server/utils/getHostname';
import axios from 'axios';

const HEALTH_CHECK_TTL_MS = 5 * 60 * 1000;

export type IntegrationHealthState = 'not_configured' | 'healthy' | 'degraded';

export interface IntegrationHealth {
  state: IntegrationHealthState;
  detail: string;
  checkedAt: string | null;
}

export type JellyfinTraktUserState =
  | 'ready'
  | 'needs_session_refresh'
  | 'needs_trakt_link'
  | 'needs_access'
  | 'unavailable';

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
): Promise<JellyfinTraktUserReadiness> => {
  if (!user.jellyfinAuthToken) {
    return {
      userId: user.id,
      displayName: user.displayName,
      state: 'needs_session_refresh',
    };
  }

  try {
    const response = await axios.get<{
      IsLinked?: unknown;
      AllowExternalTokenAccess?: unknown;
    }>(`${getHostname()}/Trakt/me`, {
      headers: {
        Authorization: `MediaBrowser Token=${user.jellyfinAuthToken}`,
      },
      timeout: 5000,
    });

    const state: JellyfinTraktUserState =
      response.data.IsLinked !== true
        ? 'needs_trakt_link'
        : response.data.AllowExternalTokenAccess !== true
          ? 'needs_access'
          : 'ready';
    return { userId: user.id, displayName: user.displayName, state };
  } catch (e) {
    const status = axios.isAxiosError(e) ? e.response?.status : undefined;
    return {
      userId: user.id,
      displayName: user.displayName,
      state:
        status === 401 || status === 403
          ? 'needs_session_refresh'
          : 'unavailable',
    };
  }
};

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
  if (!settings.jellyfin.apiKey) {
    return {
      ...degraded('Jellyfin is configured but its API token is missing.'),
      readiness: emptyJellyfinReadiness(),
    };
  }

  try {
    await new JellyfinAPI(
      getHostname(),
      settings.jellyfin.apiKey
    ).getSystemInfo();
    const users = await getRepository(User)
      .createQueryBuilder('user')
      .addSelect('user.jellyfinAuthToken')
      .where('user.jellyfinUserId IS NOT NULL')
      .getMany();
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

    if (readiness.eligibleUsers === 0) {
      return {
        ...degraded(
          'Jellyfin is reachable, but no Foreseer users are linked to Jellyfin.'
        ),
        readiness,
      };
    }
    if (readiness.readyUsers !== readiness.eligibleUsers) {
      return {
        ...degraded(
          `Jellyfin is reachable. ${readiness.readyUsers} of ${readiness.eligibleUsers} users are ready for Better Trakt.`
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
  } catch {
    return {
      ...degraded('Jellyfin could not be reached with its saved API token.'),
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

export const getIntegrationHealth =
  async (): Promise<IntegrationHealthResponse> => {
    if (cachedHealth && cachedHealth.expiresAt > Date.now()) {
      return cachedHealth.value;
    }

    const provider =
      getSettings().trakt.provider === 'jellyfin' ? 'jellyfin' : 'direct';
    const [direct, jellyfin, mdblist] = await Promise.all([
      checkDirectTrakt(),
      checkJellyfinTrakt(),
      checkMdblist(),
    ]);
    const active = provider === 'jellyfin' ? jellyfin : direct;
    const value: IntegrationHealthResponse = {
      trakt: { provider, ...active, direct, jellyfin },
      mdblist,
    };

    cachedHealth = { value, expiresAt: Date.now() + HEALTH_CHECK_TTL_MS };
    return value;
  };
