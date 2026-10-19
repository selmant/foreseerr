import ExternalAPI from '@server/api/externalapi';
import type {
  SimklActivities,
  SimklDeviceCodeResponse,
  SimklOAuthTokenResponse,
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

/** Simkl (or a proxy on the way) refused the request; keeps its explanation. */
export class SimklRequestError extends Error {
  constructor(
    public readonly status: number,
    detail?: string,
    cause?: unknown
  ) {
    super(
      `Simkl rejected the request (HTTP ${status})${detail ? `: ${detail}` : ''}`
    );
    this.name = 'SimklRequestError';
    this.cause = cause;
  }
}

/**
 * An AUTH V2 (`/oauth2/*`) endpoint answered an RFC 6749 error. Callers branch
 * on `code` only; Simkl documents `error_description` as free to change.
 */
export class SimklOAuthError extends SimklRequestError {
  constructor(
    status: number,
    public readonly code: string,
    detail?: string,
    cause?: unknown
  ) {
    super(status, detail, cause);
    this.name = 'SimklOAuthError';
  }
}

const SIMKL_ERROR_DETAIL_LIMIT = 200;

/**
 * Simkl answers `{ error, message }` (V1) or `{ error, error_description }`
 * (V2); proxies tend to answer HTML or text.
 */
export const simklErrorDetail = (data: unknown): string | undefined => {
  let text = '';
  if (data && typeof data === 'object') {
    const { message, error, error_description } = data as {
      message?: unknown;
      error?: unknown;
      error_description?: unknown;
    };
    text = [error, error_description ?? message]
      .filter(
        (part): part is string => typeof part === 'string' && part.length > 0
      )
      .join(' — ');
  } else if (typeof data === 'string') {
    text = data
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return text ? text.slice(0, SIMKL_ERROR_DETAIL_LIMIT) : undefined;
};

/** AUTH V2 grants both scopes; Foreseerr writes history and ratings. */
const SIMKL_OAUTH2_SCOPE = 'media:read media:write';
const SIMKL_DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** V2 access tokens last 7 days; Simkl suggests refreshing a day early. */
const SIMKL_REFRESH_WINDOW_SECONDS = 24 * 60 * 60;

export type SimklTokenState = {
  accessToken: string;
  /** Unix seconds; absent for V1 tokens, which do not expire. */
  expiresAt?: number;
};

/** V2 rejects a V1 Client ID (and an unknown one) as `invalid_client`. */
export const isSimklV1ClientError = (error: unknown): boolean =>
  error instanceof SimklOAuthError && error.code === 'invalid_client';

type SimklOptions = {
  clientId?: string;
  accessToken?: string;
  tokenExpiresAt?: number;
  /** Only set for V2 links, which carry a refresh token. */
  refreshTokens?: (staleAccessToken: string) => Promise<SimklTokenState>;
  onUnauthorized?: () => Promise<void>;
};

/** Small client deliberately serializes calls: Simkl limits uncached reads to 10/s. */
export default class SimklAPI extends ExternalAPI {
  private readonly clientId: string;
  private readonly rawAxios: AxiosInstance;
  private readonly onUnauthorized?: () => Promise<void>;
  private readonly refreshTokens?: SimklOptions['refreshTokens'];
  private accessToken?: string;
  private tokenExpiresAt?: number;
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
    super(SIMKL_BASE_URL, {}, { headers });
    this.clientId = clientId;
    this.accessToken = options.accessToken;
    this.tokenExpiresAt = options.tokenExpiresAt;
    this.refreshTokens = options.refreshTokens;
    this.onUnauthorized = options.onUnauthorized;
    this.rawAxios = axios.create({
      baseURL: SIMKL_BASE_URL,
      timeout: getSettings().network.apiRequestTimeout,
      headers,
    });
    // Read per request: a refresh replaces the token mid-session.
    this.rawAxios.interceptors.request.use((config) => {
      if (this.accessToken)
        config.headers.Authorization = `Bearer ${this.accessToken}`;
      return config;
    });
    this.rawAxios.interceptors.request.use(proxyRequestInterceptor);
  }

  private async refresh(): Promise<void> {
    if (!this.refreshTokens || !this.accessToken) return;
    const tokens = await this.refreshTokens(this.accessToken);
    this.accessToken = tokens.accessToken;
    this.tokenExpiresAt = tokens.expiresAt;
  }

  private async ensureFreshToken(): Promise<void> {
    if (
      this.refreshTokens &&
      this.tokenExpiresAt &&
      this.tokenExpiresAt <=
        Math.floor(Date.now() / 1000) + SIMKL_REFRESH_WINDOW_SECONDS
    )
      await this.refresh();
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
    await this.ensureFreshToken();
    let refreshedAfterUnauthorized = false;
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
        // A 401 rejected the request before applying it, so even a write is
        // safe to repeat once with a refreshed token.
        if (
          status === 401 &&
          this.refreshTokens &&
          !refreshedAfterUnauthorized
        ) {
          refreshedAfterUnauthorized = true;
          await this.refresh();
          continue;
        }
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
        throw new SimklRequestError(
          status,
          simklErrorDetail(error.response?.data),
          error
        );
      }
    }
  }

  /**
   * Form-encoded POST to an AUTH V2 endpoint. These answer RFC 6749 errors and
   * must never reach `onUnauthorized`: their 401 is about the app, not a user.
   */
  private async oauth2Post<T>(
    path: string,
    params: Record<string, string>
  ): Promise<T> {
    await this.pace(true);
    const query = new URLSearchParams({
      client_id: this.clientId,
      'app-name': 'foreseerr',
      'app-version': getAppVersion(),
    });
    try {
      const response = await this.rawAxios.post<T>(
        `${path}?${query}`,
        new URLSearchParams({ client_id: this.clientId, ...params }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      return response.data;
    } catch (error) {
      const status = axios.isAxiosError(error)
        ? error.response?.status
        : undefined;
      if (status === 429) {
        const retryAfter = Number(error.response?.headers['retry-after']) || 1;
        throw new SimklRateLimitedError(Math.max(1, retryAfter));
      }
      const data = axios.isAxiosError(error) ? error.response?.data : undefined;
      const code =
        data && typeof data === 'object'
          ? (data as { error?: unknown }).error
          : undefined;
      if (status && typeof code === 'string' && code)
        throw new SimklOAuthError(status, code, simklErrorDetail(data), error);
      if (!status || status >= 500)
        throw new SimklTemporarilyUnavailableError(error);
      throw new SimklRequestError(status, simklErrorDetail(data), error);
    }
  }

  /**
   * Both PIN endpoints check the Client ID; catalogs and title lookups accept
   * any value. V2 answers `invalid_client` for V1 apps and unknown IDs alike,
   * so the V1 endpoint (412 `client_id_failed`) settles which one it is. The
   * code either issues just expires unused.
   */
  public async validateClientId(): Promise<void> {
    try {
      await this.requestDeviceCode();
    } catch (e) {
      if (!isSimklV1ClientError(e)) throw e;
      await this.requestPinCode();
    }
  }

  /** AUTH V2 device flow. Throws `invalid_client` for a V1 Client ID. */
  public async requestDeviceCode(): Promise<SimklDeviceCodeResponse> {
    return this.oauth2Post('/oauth2/device', { scope: SIMKL_OAUTH2_SCOPE });
  }

  /** Throws `authorization_pending`, `slow_down` or `expired_token` until done. */
  public async pollDeviceToken(
    deviceCode: string
  ): Promise<SimklOAuthTokenResponse> {
    return this.oauth2Post('/oauth2/token', {
      grant_type: SIMKL_DEVICE_GRANT,
      device_code: deviceCode,
    });
  }

  /** Non-rotating: Simkl returns the same refresh token with a new access token. */
  public async refreshAccessToken(
    refreshToken: string
  ): Promise<SimklOAuthTokenResponse> {
    return this.oauth2Post('/oauth2/token', {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  }

  /** Revokes the whole grant. Simkl always answers 200 (RFC 7009). */
  public async revokeToken(token: string): Promise<void> {
    await this.oauth2Post('/oauth2/revoke', { token });
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

  /** Simkl answers `null` instead of an empty object for an empty history. */
  public async getWatchedEpisodes(): Promise<Record<string, unknown> | null> {
    return this.request('get', '/sync/watched?extended=episodes');
  }

  /**
   * `GET /redirect?to=simkl&<source>=<id>` answers `301` with the Simkl URL, so
   * the redirect must not be followed. Unlike the detail endpoint this one is
   * `cache-control: no-store`, hence its own budget class.
   */
  public async redirectToSimklId(
    source: 'anidb' | 'anilist' | 'mal' | 'kitsu' | 'imdb' | 'tvdb' | 'tmdb',
    externalId: string
  ): Promise<{ simklId: string; kind: 'anime' | 'tv' | 'movies' } | undefined> {
    await this.pace(false);
    const query = new URLSearchParams({
      to: 'simkl',
      [source]: externalId,
      client_id: this.clientId,
      'app-name': 'foreseerr',
      'app-version': getAppVersion(),
    });
    const response = await this.rawAxios.get(`/redirect?${query}`, {
      maxRedirects: 0,
      validateStatus: (status) => status < 500,
    });
    const location =
      typeof response.headers?.location === 'string'
        ? response.headers.location
        : '';
    const match = location.match(/\/(anime|tv|movies)\/(\d+)/);
    if (!match) return undefined;
    return {
      kind: match[1] as 'anime' | 'tv' | 'movies',
      simklId: match[2],
    };
  }

  /**
   * A known-good id used to disambiguate Simkl's overloaded `412`, which means
   * "unknown id in that catalog", "you sent HEAD", or a real credential failure.
   * A resolver that reads `412` as "blocked" disables Simkl on the first
   * not-found; one that reads it as "not found" never notices a suspension.
   *
   * Never uses HEAD: `HEAD /anime/39687` answers 412 while `GET` answers 200.
   */
  public async sentinelIsHealthy(): Promise<boolean> {
    try {
      const detail = await this.getTitle('anime', '39687');
      return Boolean(detail && Object.keys(detail).length);
    } catch {
      return false;
    }
  }

  /**
   * Write one episode's watch state using explicit ids and numbers.
   *
   * `use_tvdb_anime_seasons` is deliberately not sent: it asks Simkl to
   * reinterpret the season numbers server-side, which silently disagrees with
   * whatever numbering the caller read the episode under. The mapping layer
   * translates the coordinates before the call instead, so what is written is
   * what was resolved.
   */
  public async setEpisodeHistory(
    ids: {
      simkl?: string | number;
      tmdb?: number;
      tvdb?: number;
      anidb?: number;
    },
    season: number,
    episode: number,
    watched: boolean
  ): Promise<unknown> {
    const identifiers = Object.fromEntries(
      Object.entries(ids).filter(([, value]) => Boolean(value))
    );
    if (!Object.keys(identifiers).length) {
      throw new Error('setEpisodeHistory requires at least one id');
    }
    return this.request(
      'post',
      watched ? '/sync/history' : '/sync/history/remove',
      {
        shows: [
          {
            ids: identifiers,
            seasons: [{ number: season, episodes: [{ number: episode }] }],
          },
        ],
      }
    );
  }
}
