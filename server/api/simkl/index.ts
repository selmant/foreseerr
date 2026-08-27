import ExternalAPI from '@server/api/externalapi';
import type {
  SimklActivities,
  SimklPinCodeResponse,
  SimklPinTokenResponse,
  SimklSyncResponse,
  SimklUserSettingsResponse,
} from '@server/api/simkl/interfaces';
import { getSettings } from '@server/lib/settings';
import { getAppVersion } from '@server/utils/appVersion';
import { proxyRequestInterceptor } from '@server/utils/customProxyAgent';
import axios, { type AxiosInstance } from 'axios';

const SIMKL_BASE_URL = 'https://api.simkl.com';

export class SimklNotConfiguredError extends Error {
  constructor() {
    super('Simkl application Client ID is not configured');
    this.name = 'SimklNotConfiguredError';
  }
}

export class SimklNotLinkedError extends Error {
  constructor() {
    super('User has not linked a Simkl account');
    this.name = 'SimklNotLinkedError';
  }
}

export class SimklRateLimitedError extends Error {
  constructor(public readonly retryAfterSeconds = 1) {
    super(`Simkl API rate limited; retry after ${retryAfterSeconds}s`);
    this.name = 'SimklRateLimitedError';
  }
}

export class SimklUnauthorizedError extends Error {
  constructor() {
    super('Simkl authorization was rejected; reconnect the linked account');
    this.name = 'SimklUnauthorizedError';
  }
}

export class SimklTemporarilyUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('Simkl is temporarily unavailable');
    this.name = 'SimklTemporarilyUnavailableError';
    this.cause = cause;
  }
}

type SimklOptions = {
  clientId?: string;
  accessToken?: string;
  onUnauthorized?: () => Promise<void>;
};

/** Small client deliberately serializes calls: Simkl limits uncached reads to 10/s. */
export default class SimklAPI extends ExternalAPI {
  private readonly clientId: string;
  private readonly rawAxios: AxiosInstance;
  private readonly onUnauthorized?: () => Promise<void>;
  private unauthorizedHandled = false;
  private nextRequestAt = 0;

  constructor(options: SimklOptions = {}) {
    const clientId = (options.clientId ?? getSettings().simkl.clientId).trim();
    if (!clientId) throw new SimklNotConfiguredError();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'simkl-api-key': clientId,
      'app-name': 'foreseerr',
      'app-version': getAppVersion(),
      'User-Agent': `Foreseerr/${getAppVersion()} (Simkl integration)`,
    };
    if (options.accessToken)
      headers.Authorization = `Bearer ${options.accessToken}`;
    super(SIMKL_BASE_URL, {}, { headers });
    this.clientId = clientId;
    this.onUnauthorized = options.onUnauthorized;
    this.rawAxios = axios.create({
      baseURL: SIMKL_BASE_URL,
      timeout: getSettings().network.apiRequestTimeout,
      headers,
    });
    this.rawAxios.interceptors.request.use(proxyRequestInterceptor);
  }

  private async pace(post = false): Promise<void> {
    const interval = post ? 1000 : 100;
    const wait = Math.max(0, this.nextRequestAt - Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    this.nextRequestAt = Date.now() + interval;
  }

  private async request<T>(
    method: 'get' | 'post',
    path: string,
    body?: unknown
  ): Promise<T> {
    await this.pace(method === 'post');
    const separator = path.includes('?') ? '&' : '?';
    const requiredParameters = new URLSearchParams({
      client_id: this.clientId,
      'app-name': 'foreseerr',
      'app-version': getAppVersion(),
    });
    const requestPath = `${path}${separator}${requiredParameters}`;
    for (let attempt = 0; ; attempt++) {
      try {
        const response =
          method === 'get'
            ? await this.rawAxios.get<T>(requestPath)
            : await this.rawAxios.post<T>(requestPath, body);
        return response.data;
      } catch (error) {
        const status = axios.isAxiosError(error)
          ? error.response?.status
          : undefined;
        if (status === 401) {
          if (this.onUnauthorized && !this.unauthorizedHandled) {
            this.unauthorizedHandled = true;
            await this.onUnauthorized();
          }
          throw new SimklUnauthorizedError();
        }
        if (status === 429) {
          const retryAfter =
            Number(error.response?.headers['retry-after']) || 1;
          throw new SimklRateLimitedError(Math.max(1, retryAfter));
        }
        // GET requests may safely retry once after a network or temporary
        // upstream failure. Mutating requests are deliberately never retried.
        if (method === 'get' && attempt === 0 && (!status || status >= 500)) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        if (!status || status >= 500)
          throw new SimklTemporarilyUnavailableError(error);
        throw error;
      }
    }
  }

  /** Requires a real Client ID; `/movies/trending` succeeds without one. */
  public async validateClientId(): Promise<void> {
    await this.request('get', '/tv/best/all');
  }

  public async requestPinCode(): Promise<SimklPinCodeResponse> {
    return this.request('get', '/oauth/pin');
  }

  public async pollPinToken(userCode: string): Promise<SimklPinTokenResponse> {
    return this.request('get', `/oauth/pin/${encodeURIComponent(userCode)}`);
  }

  public async getUserSettings(): Promise<SimklUserSettingsResponse> {
    return this.request('post', '/users/settings', {});
  }

  public async getActivities(): Promise<SimklActivities> {
    return this.request('get', '/sync/activities');
  }

  public async getAllItems(
    type?: 'shows' | 'movies' | 'anime',
    params: Record<string, string | number | boolean> = {}
  ): Promise<SimklSyncResponse> {
    const query = new URLSearchParams(
      Object.entries(params).map(([key, value]) => [key, String(value)])
    );
    return this.request(
      'get',
      `/sync/all-items${type ? `/${type}` : ''}${query.size ? `?${query}` : ''}`
    );
  }

  public async addHistory(
    mediaType: 'movie' | 'tv',
    tmdbId: number
  ): Promise<unknown> {
    return this.request('post', '/sync/history', {
      [mediaType === 'movie' ? 'movies' : 'shows']: [{ ids: { tmdb: tmdbId } }],
    });
  }

  public async removeHistory(
    mediaType: 'movie' | 'tv',
    tmdbId: number
  ): Promise<unknown> {
    return this.request('post', '/sync/history/remove', {
      [mediaType === 'movie' ? 'movies' : 'shows']: [{ ids: { tmdb: tmdbId } }],
    });
  }

  public async setRating(
    mediaType: 'movie' | 'tv',
    tmdbId: number,
    rating: number
  ): Promise<unknown> {
    return this.request('post', '/sync/ratings', {
      [mediaType === 'movie' ? 'movies' : 'shows']: [
        { ids: { tmdb: tmdbId }, rating },
      ],
    });
  }

  public async removeRating(
    mediaType: 'movie' | 'tv',
    tmdbId: number
  ): Promise<unknown> {
    return this.request('post', '/sync/ratings/remove', {
      [mediaType === 'movie' ? 'movies' : 'shows']: [{ ids: { tmdb: tmdbId } }],
    });
  }

  public async getCatalog(
    path: string,
    params: Record<string, string | number | boolean> = {}
  ): Promise<unknown> {
    const query = new URLSearchParams(
      Object.entries(params).map(([key, value]) => [key, String(value)])
    );
    return this.request('get', `${path}${query.size ? `?${query}` : ''}`);
  }

  public async getTitle(
    kind: 'movies' | 'tv' | 'anime',
    simklId: string
  ): Promise<Record<string, unknown>> {
    const payload = await this.request<unknown>(
      'get',
      `/${kind}/${encodeURIComponent(simklId)}`
    );
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  }

  public async getCdnCatalog(path: string): Promise<unknown> {
    await this.pace(false);
    const requiredParameters = new URLSearchParams({
      client_id: this.clientId,
      'app-name': 'foreseerr',
      'app-version': getAppVersion(),
    });
    const url = `https://data.simkl.in${path}?${requiredParameters}`;
    try {
      const response = await this.rawAxios.get<unknown>(url);
      return response.data;
    } catch (error) {
      const status = axios.isAxiosError(error)
        ? error.response?.status
        : undefined;
      if (status === 429) {
        const retryAfter = Number(error.response?.headers['retry-after']) || 1;
        throw new SimklRateLimitedError(Math.max(1, retryAfter));
      }
      throw new SimklTemporarilyUnavailableError(error);
    }
  }

  public async getWatchedEpisodes(): Promise<Record<string, unknown>> {
    return this.request('get', '/sync/watched?extended=episodes');
  }

  public async setEpisodeHistory(
    tmdbShowId: number,
    season: number,
    episode: number,
    watched: boolean
  ): Promise<unknown> {
    return this.request(
      'post',
      watched ? '/sync/history' : '/sync/history/remove',
      {
        shows: [
          {
            ids: { tmdb: tmdbShowId },
            seasons: [{ number: season, episodes: [{ number: episode }] }],
          },
        ],
        use_tvdb_anime_seasons: true,
      }
    );
  }
}
