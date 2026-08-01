import JellyfinAPI from '@server/api/jellyfin';
import MdblistAPI from '@server/api/mdblist';
import TraktAPI from '@server/api/trakt';
import { getSettings } from '@server/lib/settings';
import { getHostname } from '@server/utils/getHostname';

const HEALTH_CHECK_TTL_MS = 5 * 60 * 1000;

export type IntegrationHealthState = 'not_configured' | 'healthy' | 'degraded';

export interface IntegrationHealth {
  state: IntegrationHealthState;
  detail: string;
  checkedAt: string | null;
}

export interface IntegrationHealthResponse {
  trakt: IntegrationHealth & { provider: 'direct' | 'jellyfin' };
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
    return healthy('Trakt application credentials are valid.');
  } catch {
    return degraded('Trakt application credentials could not be validated.');
  }
};

const checkJellyfinTrakt = async (): Promise<IntegrationHealth> => {
  const settings = getSettings();
  if (!settings.jellyfin.ip) {
    return notConfigured('Jellyfin is not configured.');
  }
  if (!settings.jellyfin.apiKey) {
    return degraded('Jellyfin is configured but its API token is missing.');
  }

  try {
    await new JellyfinAPI(
      getHostname(),
      settings.jellyfin.apiKey
    ).getSystemInfo();
    return healthy(
      'Jellyfin is reachable. Better Trakt access is checked per linked user.'
    );
  } catch {
    return degraded('Jellyfin could not be reached with its saved API token.');
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
    const [trakt, mdblist] = await Promise.all([
      provider === 'jellyfin' ? checkJellyfinTrakt() : checkDirectTrakt(),
      checkMdblist(),
    ]);
    const value: IntegrationHealthResponse = {
      trakt: { provider, ...trakt },
      mdblist,
    };

    cachedHealth = { value, expiresAt: Date.now() + HEALTH_CHECK_TTL_MS };
    return value;
  };
