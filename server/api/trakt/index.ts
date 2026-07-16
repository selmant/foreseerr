import ExternalAPI from '@server/api/externalapi';
import type {
  TraktDeviceCodeResponse,
  TraktDevicePollResult,
  TraktListEntry,
  TraktListMetadata,
  TraktMediaItem,
  TraktMediaObject,
  TraktSearchListEntry,
  TraktTokenResponse,
  TraktUserList,
  TraktUserSettingsResponse,
} from '@server/api/trakt/interfaces';
import cacheManager from '@server/lib/cache';
import logger from '@server/logger';
import { proxyRequestInterceptor } from '@server/utils/customProxyAgent';
import axios, { type AxiosInstance } from 'axios';

const TRAKT_BASE_URL = 'https://api.trakt.tv';
export const TRAKT_RECOMMENDATIONS_LIMIT_MAX = 500;
const TRAKT_REFRESH_WINDOW_SECONDS = 300;
const TRAKT_RETRY_AFTER_MAX_SECONDS = 5;
const TRAKT_RATE_LIMIT_FALLBACK_SECONDS = 1;

export class TraktDevicePendingError extends Error {
  constructor(message = 'Trakt device authorization pending') {
    super(message);
    this.name = 'TraktDevicePendingError';
  }
}

export class TraktDeviceExpiredError extends Error {
  constructor(message = 'Trakt device code expired') {
    super(message);
    this.name = 'TraktDeviceExpiredError';
  }
}

export class TraktDeviceDeniedError extends Error {
  constructor(message = 'Trakt authorization was denied') {
    super(message);
    this.name = 'TraktDeviceDeniedError';
  }
}

interface TraktAPIOptions {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  onTokenRefresh?: (tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }) => Promise<void> | void;
}

class TraktAPI extends ExternalAPI {
  private clientId: string;
  private clientSecret: string;
  private accessToken?: string;
  private refreshToken?: string;
  private expiresAt: number;
  private onTokenRefresh?: TraktAPIOptions['onTokenRefresh'];
  private rawAxios: AxiosInstance;

  constructor(options: TraktAPIOptions) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': options.clientId,
    };

    if (options.accessToken) {
      headers.Authorization = `Bearer ${options.accessToken}`;
    }

    super(
      TRAKT_BASE_URL,
      {},
      {
        headers,
        nodeCache: cacheManager.getCache('trakt').data,
        rateLimit: {
          maxRPS: 4,
          maxRequests: 40,
        },
      }
    );

    this.clientId = options.clientId.trim();
    this.clientSecret = options.clientSecret.trim();
    this.accessToken = options.accessToken;
    this.refreshToken = options.refreshToken;
    this.expiresAt = options.expiresAt ?? 0;
    this.onTokenRefresh = options.onTokenRefresh;

    this.rawAxios = axios.create({
      baseURL: TRAKT_BASE_URL,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'trakt-api-version': '2',
        'trakt-api-key': this.clientId,
      },
    });
    this.rawAxios.interceptors.request.use(proxyRequestInterceptor);
  }

  public static parseListUrl(value: string): {
    username: string | null;
    listRef: string;
  } {
    const text = decodeURIComponent(String(value || '').trim());
    if (!text) {
      throw new Error('List URL or reference is required');
    }

    if (text.startsWith('http://') || text.startsWith('https://')) {
      const parsed = new URL(text);
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length >= 4 && parts[0] === 'users' && parts[2] === 'lists') {
        return { username: parts[1], listRef: parts[3] };
      }
      if (
        parts.length === 3 &&
        parts[0] === 'users' &&
        parts[2] === 'watchlist'
      ) {
        return { username: parts[1], listRef: 'watchlist' };
      }
      if (parts.length >= 2 && parts[0] === 'lists') {
        return { username: null, listRef: parts[1] };
      }
      throw new Error(`Unsupported Trakt list URL: ${value}`);
    }

    if (text.includes('/')) {
      const [user, ...rest] = text.split('/');
      const listRef = rest.join('/').trim().toLowerCase();
      if (!user.trim() || !listRef) {
        throw new Error(`Invalid Trakt list reference: ${value}`);
      }
      return { username: user.trim(), listRef };
    }

    return { username: null, listRef: text };
  }

  public async requestDeviceCode(): Promise<TraktDeviceCodeResponse> {
    const response = await this.rawAxios.post<TraktDeviceCodeResponse>(
      '/oauth/device/code',
      { client_id: this.clientId }
    );
    return response.data;
  }

  public async pollForToken(
    deviceCode: string
  ): Promise<TraktDevicePollResult> {
    try {
      const response = await this.rawAxios.post<TraktTokenResponse>(
        '/oauth/device/token',
        {
          code: deviceCode,
          client_id: this.clientId,
          client_secret: this.clientSecret,
        },
        { validateStatus: () => true }
      );

      if (response.status >= 200 && response.status < 300) {
        const tokens = this.applyTokens(response.data);
        return { status: 'authorized', tokens };
      }
      if (
        response.status === 400 ||
        response.status === 429 ||
        response.status === 409
      ) {
        return { status: 'pending' };
      }
      if (response.status === 410) {
        return { status: 'expired' };
      }
      if (response.status === 418) {
        return { status: 'denied' };
      }

      throw new Error(
        `Trakt device authorization failed (status ${response.status})`
      );
    } catch (e) {
      if (
        e instanceof Error &&
        e.message.startsWith('Trakt device authorization failed')
      ) {
        throw e;
      }
      throw new Error(
        `Trakt API request failed: POST /oauth/device/token: ${
          e instanceof Error ? e.message : 'unknown error'
        }`
      );
    }
  }

  public async refreshAccessToken(): Promise<
    TraktTokenResponse & { expiresAt: number }
  > {
    if (!this.refreshToken) {
      throw new Error('Cannot refresh Trakt token without a refresh token');
    }

    const response = await this.rawAxios.post<TraktTokenResponse>(
      '/oauth/token',
      {
        refresh_token: this.refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
        grant_type: 'refresh_token',
      }
    );

    return this.applyTokens(response.data);
  }

  public async getUserSettings(): Promise<{
    username: string;
    traktUserId: string;
  }> {
    await this.ensureFreshToken();
    const payload =
      await this.getAuthenticated<TraktUserSettingsResponse>('/users/settings');
    const user = payload.user ?? {};
    const ids = user.ids ?? {};
    const username = user.username || user.name || user.slug || ids.slug || '';
    const traktUserId = String(
      ids.uuid || ids.slug || ids.trakt || user.username || username
    );
    return { username, traktUserId };
  }

  public async getRecommendations(
    mediaType: 'movie' | 'tv',
    options: {
      limit?: number;
      ignoreCollected?: boolean;
      ignoreWatchlisted?: boolean;
    } = {}
  ): Promise<TraktMediaItem[]> {
    await this.ensureFreshToken();
    const path =
      mediaType === 'movie'
        ? '/recommendations/movies'
        : '/recommendations/shows';
    const params: Record<string, string | number> = {
      limit: Math.max(
        1,
        Math.min(options.limit ?? 20, TRAKT_RECOMMENDATIONS_LIMIT_MAX)
      ),
      extended: 'min',
    };
    if (options.ignoreCollected) {
      params.ignore_collected = 'true';
    }
    if (options.ignoreWatchlisted) {
      params.ignore_watchlisted = 'true';
    }

    const payload = await this.getAuthenticated<TraktMediaObject[]>(path, {
      params,
    });
    return this.normalizeRecommendationItems(payload, mediaType);
  }

  public async getUserLists(listUser = 'me'): Promise<TraktListMetadata[]> {
    await this.ensureFreshToken();
    const user = (listUser || 'me').trim() || 'me';
    const payload = await this.getAuthenticated<TraktUserList[]>(
      `/users/${user}/lists`,
      { params: { extended: 'min' } }
    );
    return this.normalizeUserLists(payload);
  }

  public async addToHistory(
    mediaType: 'movie' | 'tv',
    tmdbId: number,
    watchedAt?: string
  ): Promise<unknown> {
    const item: Record<string, unknown> = {
      ids: { tmdb: Number(tmdbId) },
    };
    if (watchedAt) {
      item.watched_at = watchedAt;
    }
    return this.postAuthenticated(
      '/sync/history',
      this.syncBody(mediaType, item)
    );
  }

  public async removeFromHistory(
    mediaType: 'movie' | 'tv',
    tmdbId: number
  ): Promise<unknown> {
    return this.postAuthenticated(
      '/sync/history/remove',
      this.syncBody(mediaType, { ids: { tmdb: Number(tmdbId) } })
    );
  }

  public async addRating(
    mediaType: 'movie' | 'tv',
    tmdbId: number,
    rating: number
  ): Promise<unknown> {
    const value = Math.trunc(rating);
    if (value < 1 || value > 10) {
      throw new Error('Trakt rating must be between 1 and 10');
    }
    return this.postAuthenticated(
      '/sync/ratings',
      this.syncBody(mediaType, {
        ids: { tmdb: Number(tmdbId) },
        rating: value,
      })
    );
  }

  public async removeRating(
    mediaType: 'movie' | 'tv',
    tmdbId: number
  ): Promise<unknown> {
    return this.postAuthenticated(
      '/sync/ratings/remove',
      this.syncBody(mediaType, { ids: { tmdb: Number(tmdbId) } })
    );
  }

  public async getSyncWatched(
    mediaType: 'movie' | 'tv'
  ): Promise<TraktListEntry[]> {
    const path =
      mediaType === 'movie' ? '/sync/watched/movies' : '/sync/watched/shows';
    return this.getAuthenticated<TraktListEntry[]>(path);
  }

  public async getSyncRatings(
    mediaType: 'movie' | 'tv'
  ): Promise<TraktListEntry[]> {
    const path =
      mediaType === 'movie' ? '/sync/ratings/movies' : '/sync/ratings/shows';
    return this.getAuthenticated<TraktListEntry[]>(path);
  }

  public static payloadContainsTmdb(
    payload: TraktListEntry[] | undefined,
    itemKey: 'movie' | 'show',
    tmdbId: number | string
  ): boolean {
    const needle = String(tmdbId);
    for (const entry of payload || []) {
      const ids = entry?.[itemKey]?.ids;
      if (ids?.tmdb != null && String(ids.tmdb) === needle) {
        return true;
      }
    }
    return false;
  }

  public static findRatingForTmdb(
    payload: TraktListEntry[] | undefined,
    itemKey: 'movie' | 'show',
    tmdbId: number | string
  ): number | null {
    const needle = String(tmdbId);
    for (const entry of payload || []) {
      const ids = entry?.[itemKey]?.ids;
      if (ids?.tmdb != null && String(ids.tmdb) === needle) {
        return entry.rating != null ? Number(entry.rating) : null;
      }
    }
    return null;
  }

  public async searchLists(
    query: string,
    options: { limit?: number } = {}
  ): Promise<TraktListMetadata[]> {
    const q = String(query || '').trim();
    if (!q) {
      return [];
    }

    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const payload = await this.get<TraktSearchListEntry[]>(
      '/search/list',
      { params: { query: q, limit } },
      300
    );

    const items: TraktListMetadata[] = [];
    const seen = new Set<string>();
    for (const entry of payload || []) {
      if (entry.type !== 'list' || !entry.list) {
        continue;
      }
      const normalized = this.normalizeListMetadata(entry.list);
      const key = normalized.username
        ? `${normalized.username}/${normalized.slug || normalized.id}`
        : normalized.slug || normalized.id;
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      items.push(normalized);
    }

    return items;
  }

  public async getListMetadata(
    listUser: string | null,
    listRef: string
  ): Promise<TraktListMetadata> {
    const ref = String(listRef || '').trim();
    if (!ref) {
      throw new Error('listRef is required');
    }

    const path = listUser ? `/users/${listUser}/lists/${ref}` : `/lists/${ref}`;

    // Public lists can be fetched without user auth; use app key only when no token
    const payload = this.accessToken
      ? await this.getAuthenticatedOrPublic<TraktUserList>(path)
      : await this.get<TraktUserList>(path, undefined, 300);

    return this.normalizeListMetadata(payload);
  }

  public async getListItems(
    listUser: string | null,
    listRef: string,
    mediaType: 'movie' | 'tv' | 'both' = 'both',
    options: { limit?: number; page?: number } = {}
  ): Promise<TraktMediaItem[]> {
    const ref = String(listRef || '').trim();
    if (!ref) {
      throw new Error('listRef is required');
    }

    const itemTypes = this.listItemTypes(mediaType);
    const params = {
      limit: Math.max(1, Math.min(options.limit ?? 20, 100)),
      page: Math.max(1, options.page ?? 1),
      extended: 'min',
    };
    const path = listUser
      ? `/users/${listUser}/lists/${ref}/items/${itemTypes}`
      : `/lists/${ref}/items/${itemTypes}`;

    const payload = this.accessToken
      ? await this.getAuthenticatedOrPublic<TraktListEntry[]>(path, { params })
      : await this.get<TraktListEntry[]>(path, { params }, 300);

    return this.normalizeListItems(payload);
  }

  public async getWatchlistItems(
    listUser = 'me',
    mediaType: 'movie' | 'tv' | 'both' = 'both',
    options: { limit?: number; page?: number } = {}
  ): Promise<TraktMediaItem[]> {
    await this.ensureFreshToken();
    const user = (listUser || 'me').trim() || 'me';
    const perTypeLimit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const page = Math.max(1, options.page ?? 1);
    const mediaTypes: ('movie' | 'tv')[] =
      mediaType === 'both' ? ['movie', 'tv'] : [mediaType];

    const items: TraktMediaItem[] = [];
    const seen = new Set<string>();

    for (const type of mediaTypes) {
      const traktType = type === 'movie' ? 'movies' : 'shows';
      const payload = await this.getAuthenticated<TraktListEntry[]>(
        `/users/${user}/watchlist/${traktType}`,
        {
          params: {
            limit: perTypeLimit,
            page,
            extended: 'min',
          },
        }
      );
      for (const item of this.normalizeListItems(payload)) {
        const key = `${item.mediaType}:${item.tmdbId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(item);
      }
    }

    return items;
  }

  /**
   * Recent watch history (chronological). Uses /sync/history which returns
   * the authenticated user's most recent plays first.
   */
  public async getHistoryItems(
    mediaType: 'movie' | 'tv' | 'both' = 'both',
    options: { limit?: number; page?: number } = {}
  ): Promise<TraktMediaItem[]> {
    await this.ensureFreshToken();
    const perTypeLimit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const page = Math.max(1, options.page ?? 1);
    const mediaTypes: ('movie' | 'tv')[] =
      mediaType === 'both' ? ['movie', 'tv'] : [mediaType];

    const items: TraktMediaItem[] = [];
    const seen = new Set<string>();

    for (const type of mediaTypes) {
      const traktType = type === 'movie' ? 'movies' : 'shows';
      const payload = await this.getAuthenticated<TraktListEntry[]>(
        `/sync/history/${traktType}`,
        {
          params: {
            limit: perTypeLimit,
            page,
            extended: 'min',
          },
        }
      );
      for (const item of this.normalizeListItems(payload)) {
        const key = `${item.mediaType}:${item.tmdbId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(item);
      }
    }

    return items;
  }

  private applyTokens(
    payload: TraktTokenResponse
  ): TraktTokenResponse & { expiresAt: number } {
    this.accessToken = payload.access_token || this.accessToken;
    this.refreshToken = payload.refresh_token || this.refreshToken;
    const expiresIn = Number(payload.expires_in || 0);
    if (expiresIn) {
      this.expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
    }

    // Keep ExternalAPI Authorization header in sync for subsequent calls
    (this as unknown as { axios: AxiosInstance }).axios.defaults.headers.common[
      'Authorization'
    ] = `Bearer ${this.accessToken}`;

    const result = {
      ...payload,
      expiresAt: this.expiresAt,
    };

    if (this.onTokenRefresh && this.accessToken && this.refreshToken) {
      void Promise.resolve(
        this.onTokenRefresh({
          accessToken: this.accessToken,
          refreshToken: this.refreshToken,
          expiresAt: this.expiresAt,
        })
      ).catch((e) => {
        logger.error('Failed to persist refreshed Trakt tokens', {
          label: 'Trakt API',
          errorMessage: e instanceof Error ? e.message : 'unknown error',
        });
      });
    }

    return result;
  }

  private async ensureFreshToken(): Promise<void> {
    if (!this.refreshToken || !this.expiresAt) {
      return;
    }
    if (
      this.expiresAt <=
      Math.floor(Date.now() / 1000) + TRAKT_REFRESH_WINDOW_SECONDS
    ) {
      await this.refreshAccessToken();
    }
  }

  private syncBody(
    mediaType: 'movie' | 'tv',
    item: Record<string, unknown>
  ): Record<string, Record<string, unknown>[]> {
    if (mediaType === 'movie') {
      return { movies: [item] };
    }
    return { shows: [item] };
  }

  private async postAuthenticated<T>(
    endpoint: string,
    data: unknown
  ): Promise<T> {
    return this.requestWithRetry<T>('POST', endpoint, { data });
  }

  private async getAuthenticated<T>(
    endpoint: string,
    config?: { params?: Record<string, string | number> }
  ): Promise<T> {
    return this.requestWithRetry<T>('GET', endpoint, config);
  }

  private async getAuthenticatedOrPublic<T>(
    endpoint: string,
    config?: { params?: Record<string, string | number> }
  ): Promise<T> {
    try {
      return await this.getAuthenticated<T>(endpoint, config);
    } catch (e) {
      // Fall back to app-key-only for public lists if user token fails
      logger.debug('Authenticated Trakt request failed; retrying publicly', {
        label: 'Trakt API',
        endpoint,
        errorMessage: e instanceof Error ? e.message : 'unknown error',
      });
      return this.get<T>(endpoint, config, 300);
    }
  }

  private async requestWithRetry<T>(
    method: 'GET' | 'POST',
    endpoint: string,
    config?: { params?: Record<string, string | number>; data?: unknown },
    retryAuth = true,
    retryRateLimit = true
  ): Promise<T> {
    await this.ensureFreshToken();

    try {
      const response = await this.rawAxios.request<T>({
        method,
        url: endpoint,
        params: config?.params,
        data: config?.data,
        headers: this.accessToken
          ? { Authorization: `Bearer ${this.accessToken}` }
          : undefined,
        validateStatus: () => true,
      });

      if (response.status >= 200 && response.status < 300) {
        return response.data;
      }

      if (response.status === 429 && retryRateLimit) {
        const retryAfter = this.parseRetryAfter(
          response.headers['retry-after'] as string | undefined
        );
        if (retryAfter > TRAKT_RETRY_AFTER_MAX_SECONDS) {
          throw new Error(
            `Trakt API rate limited ${method} ${endpoint}; retry after ${retryAfter}s`
          );
        }
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            (retryAfter || TRAKT_RATE_LIMIT_FALLBACK_SECONDS) * 1000
          )
        );
        return this.requestWithRetry<T>(
          method,
          endpoint,
          config,
          retryAuth,
          false
        );
      }

      if (response.status === 401 && this.accessToken && retryAuth) {
        await this.refreshAccessToken();
        return this.requestWithRetry<T>(
          method,
          endpoint,
          config,
          false,
          retryRateLimit
        );
      }

      throw new Error(
        `Trakt API request failed: ${method} ${endpoint} returned ${response.status}`
      );
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Trakt API')) {
        throw e;
      }
      throw new Error(
        `Trakt API request failed: ${method} ${endpoint}: ${
          e instanceof Error ? e.message : 'unknown error'
        }`
      );
    }
  }

  private parseRetryAfter(value?: string): number {
    try {
      return Math.max(0, Number.parseInt(value || '0', 10) || 0);
    } catch {
      return 0;
    }
  }

  private listItemTypes(mediaType: 'movie' | 'tv' | 'both'): string {
    if (mediaType === 'movie') return 'movies';
    if (mediaType === 'tv') return 'shows';
    if (mediaType === 'both') return 'movies,shows';
    throw new Error("mediaType must be 'movie', 'tv', or 'both'");
  }

  private normalizeMediaItem(
    item: TraktMediaObject | undefined,
    mediaType: 'movie' | 'tv'
  ): TraktMediaItem | null {
    if (!item?.ids?.tmdb) {
      return null;
    }
    return {
      tmdbId: Number(item.ids.tmdb),
      mediaType,
      title: item.title || item.name || '',
      year: item.year,
    };
  }

  private normalizeRecommendationItems(
    payload: TraktMediaObject[] | undefined,
    mediaType: 'movie' | 'tv'
  ): TraktMediaItem[] {
    const items: TraktMediaItem[] = [];
    const seen = new Set<number>();
    for (const entry of payload || []) {
      const normalized = this.normalizeMediaItem(entry, mediaType);
      if (!normalized || seen.has(normalized.tmdbId)) continue;
      seen.add(normalized.tmdbId);
      items.push(normalized);
    }
    return items;
  }

  private normalizeListItems(
    payload: TraktListEntry[] | undefined
  ): TraktMediaItem[] {
    const items: TraktMediaItem[] = [];
    const seen = new Set<string>();
    for (const entry of payload || []) {
      let normalized: TraktMediaItem | null = null;
      if (entry.type === 'movie') {
        normalized = this.normalizeMediaItem(entry.movie, 'movie');
      } else if (entry.type === 'show' || entry.type === 'episode') {
        normalized = this.normalizeMediaItem(entry.show, 'tv');
      }
      if (!normalized) continue;
      const key = `${normalized.mediaType}:${normalized.tmdbId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(normalized);
    }
    return items;
  }

  private normalizeUserLists(
    payload: TraktUserList[] | undefined
  ): TraktListMetadata[] {
    return (payload || []).map((entry) => this.normalizeListMetadata(entry));
  }

  private normalizeListMetadata(
    payload: TraktUserList = {}
  ): TraktListMetadata {
    const ids = payload.ids || {};
    const slug = payload.slug || ids.slug || '';
    const listId = ids.trakt;
    const user = payload.user || {};
    const userIds = user.ids || {};
    const username = user.username || user.slug || userIds.slug || '';

    return {
      id: listId != null ? String(listId) : '',
      slug: String(slug),
      name: payload.name || payload.title || String(slug),
      itemCount: Number(payload.item_count || 0),
      privacy: payload.privacy,
      username: username ? String(username) : undefined,
    };
  }
}

export default TraktAPI;
