import ExternalAPI from '@server/api/externalapi';
import type {
  TraktDeviceCodeResponse,
  TraktDevicePollResult,
  TraktFetchMediaType,
  TraktLikedList,
  TraktListEntry,
  TraktListMetadata,
  TraktListSortBy,
  TraktMediaItem,
  TraktMediaObject,
  TraktSearchListEntry,
  TraktTokenResponse,
  TraktTokenState,
  TraktUserList,
  TraktUserSettingsResponse,
} from '@server/api/trakt/interfaces';
import cacheManager from '@server/lib/cache';
import {
  mergeAndPaginateTraktItems,
  paginateSortedTraktItems,
  type TraktPaginatedItems,
} from '@server/lib/trakt/mixedPagination';
import logger from '@server/logger';
import { proxyRequestInterceptor } from '@server/utils/customProxyAgent';
import axios, { type AxiosInstance } from 'axios';

const TRAKT_BASE_URL = 'https://api.trakt.tv';
export const TRAKT_RECOMMENDATIONS_LIMIT_MAX = 500;
const TRAKT_REFRESH_WINDOW_SECONDS = 300;
const TRAKT_RETRY_AFTER_MAX_SECONDS = 5;
const TRAKT_RATE_LIMIT_FALLBACK_SECONDS = 1;
const TRAKT_GET_CACHE_TTL_SECONDS = 300;
const TRAKT_CIRCUIT_FALLBACK_SECONDS = 60;
/** Trakt currently caps sync collection pages at 250 items. */
export const TRAKT_SYNC_PAGE_SIZE = 250;

/** Shared across TraktAPI instances so one 429 cools down the whole process. */
let traktCircuitOpenUntilMs = 0;

export class TraktRateLimitedError extends Error {
  public readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
    super(`Trakt API rate limited; retry after ${seconds}s`);
    this.name = 'TraktRateLimitedError';
    this.retryAfterSeconds = seconds;
  }
}

export class TraktRefreshRejectedError extends Error {
  public readonly status: number;

  constructor(status: number) {
    super('Trakt rejected the refresh token');
    this.name = 'TraktRefreshRejectedError';
    this.status = status;
  }
}

export class TraktReconnectRequiredError extends Error {
  constructor(message = 'Trakt authorization expired; reconnect your account') {
    super(message);
    this.name = 'TraktReconnectRequiredError';
  }
}

/** Test helper — clear process-wide Trakt rate-limit circuit. */
export const resetTraktRateLimitState = (): void => {
  traktCircuitOpenUntilMs = 0;
};

const remainingCircuitSeconds = (): number =>
  Math.max(0, Math.ceil((traktCircuitOpenUntilMs - Date.now()) / 1000));

const assertTraktCircuitClosed = (): void => {
  const remaining = remainingCircuitSeconds();
  if (remaining > 0) {
    throw new TraktRateLimitedError(remaining);
  }
};

const openTraktCircuit = (retryAfterSeconds: number): void => {
  const seconds = Math.max(
    TRAKT_CIRCUIT_FALLBACK_SECONDS,
    Math.ceil(retryAfterSeconds || TRAKT_CIRCUIT_FALLBACK_SECONDS)
  );
  const openUntil = Date.now() + seconds * 1000;
  if (openUntil > traktCircuitOpenUntilMs) {
    traktCircuitOpenUntilMs = openUntil;
    logger.warn('Trakt circuit opened after rate limit', {
      label: 'Trakt API',
      retryAfterSeconds: seconds,
      nextProbeAt: new Date(openUntil).toISOString(),
    });
  }
};

interface TraktAPIOptions {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  refreshTokens?: (currentTokens: TraktTokenState) => Promise<TraktTokenState>;
}

class TraktAPI extends ExternalAPI {
  private clientId: string;
  private clientSecret: string;
  private accessToken?: string;
  private refreshToken?: string;
  private expiresAt: number;
  private refreshTokens?: TraktAPIOptions['refreshTokens'];
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
      }
    );

    this.clientId = options.clientId.trim();
    this.clientSecret = options.clientSecret.trim();
    this.accessToken = options.accessToken;
    this.refreshToken = options.refreshToken;
    this.expiresAt = options.expiresAt ?? 0;
    this.refreshTokens = options.refreshTokens;

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

  protected async get<T>(
    endpoint: string,
    config?: {
      params?: Record<string, string | number>;
      headers?: Record<string, string>;
    },
    ttl?: number
  ): Promise<T> {
    assertTraktCircuitClosed();
    try {
      return await super.get<T>(endpoint, config, ttl);
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response
        ?.status;
      if (status === 429) {
        const headers = (e as { response?: { headers?: unknown } })?.response
          ?.headers;
        const retryAfter = this.parseRetryAfter(
          this.headerValue(headers, 'retry-after')
        );
        openTraktCircuit(retryAfter || TRAKT_CIRCUIT_FALLBACK_SECONDS);
        throw new TraktRateLimitedError(
          retryAfter ||
            remainingCircuitSeconds() ||
            TRAKT_CIRCUIT_FALLBACK_SECONDS
        );
      }
      throw e;
    }
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
      if (response.status === 400) {
        return { status: 'pending' };
      }
      if (response.status === 429) {
        return { status: 'slow_down' };
      }
      if (response.status === 409) {
        return { status: 'already_used' };
      }
      if (response.status === 404) {
        return { status: 'invalid' };
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

  /**
   * Verify application credentials against Trakt without user interaction.
   * A valid client ID can request a device code; an invalid client secret is
   * rejected when exercising the refresh-token grant with a dummy token.
   */
  public async validateApplicationCredentials(): Promise<void> {
    try {
      await this.requestDeviceCode();
    } catch {
      throw new Error('Invalid Trakt Client ID');
    }

    const response = await this.rawAxios.post(
      '/oauth/token',
      {
        refresh_token: 'foreseerr-credential-validation',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
        grant_type: 'refresh_token',
      },
      { validateStatus: () => true }
    );

    if (response.status === 401 || response.status === 403) {
      throw new Error('Invalid Trakt Client Secret');
    }
  }

  public async refreshAccessToken(): Promise<TraktTokenState> {
    if (!this.refreshToken) {
      throw new Error('Cannot refresh Trakt token without a refresh token');
    }

    if (this.refreshTokens && this.accessToken) {
      const tokens = await this.refreshTokens({
        accessToken: this.accessToken,
        refreshToken: this.refreshToken,
        expiresAt: this.expiresAt,
      });
      this.applyTokenState(tokens);
      return tokens;
    }

    const response = await this.rawAxios.post<TraktTokenResponse>(
      '/oauth/token',
      {
        refresh_token: this.refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
        grant_type: 'refresh_token',
      },
      { validateStatus: () => true }
    );

    if (response.status === 400 || response.status === 401) {
      throw new TraktRefreshRejectedError(response.status);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Trakt token refresh failed with status ${response.status}`
      );
    }

    const applied = this.applyTokens(response.data);
    return {
      accessToken: applied.access_token,
      refreshToken: applied.refresh_token,
      expiresAt: applied.expiresAt,
    };
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
      extended?: 'min' | 'full';
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
      extended: options.extended ?? 'min',
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

  public async getLikedLists(): Promise<TraktListMetadata[]> {
    await this.ensureFreshToken();
    const payload =
      await this.getAuthenticated<TraktLikedList[]>('/users/likes/lists');

    return (payload || [])
      .map((entry) =>
        entry.list
          ? {
              ...this.normalizeListMetadata(entry.list),
              isLiked: true as const,
            }
          : null
      )
      .filter(
        (list): list is TraktListMetadata & { isLiked: true } => list !== null
      );
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

  public async addEpisodeToHistory(
    tmdbShowId: number,
    seasonNumber: number,
    episodeNumber: number
  ): Promise<unknown> {
    return this.postAuthenticated(
      '/sync/history',
      TraktAPI.episodeHistoryPayload(tmdbShowId, seasonNumber, episodeNumber)
    );
  }

  public async removeEpisodeFromHistory(
    tmdbShowId: number,
    seasonNumber: number,
    episodeNumber: number
  ): Promise<unknown> {
    return this.postAuthenticated(
      '/sync/history/remove',
      TraktAPI.episodeHistoryPayload(tmdbShowId, seasonNumber, episodeNumber)
    );
  }

  public static episodeHistoryPayload(
    tmdbShowId: number,
    seasonNumber: number,
    episodeNumber: number
  ): Record<string, unknown> {
    return {
      shows: [
        {
          ids: { tmdb: Number(tmdbShowId) },
          seasons: [
            { number: seasonNumber, episodes: [{ number: episodeNumber }] },
          ],
        },
      ],
    };
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
    return this.getAllSyncPages(
      path,
      mediaType === 'tv' ? { extended: 'progress' } : undefined
    );
  }

  public async getSyncRatings(
    mediaType: 'movie' | 'tv'
  ): Promise<TraktListEntry[]> {
    const path =
      mediaType === 'movie' ? '/sync/ratings/movies' : '/sync/ratings/shows';
    return this.getAllSyncPages(path);
  }

  private async getAllSyncPages(
    path: string,
    params: Record<string, string | number> = {}
  ): Promise<TraktListEntry[]> {
    const items: TraktListEntry[] = [];
    let page = 1;

    while (true) {
      const batch = await this.getAuthenticated<TraktListEntry[]>(path, {
        params: {
          ...params,
          page,
          limit: TRAKT_SYNC_PAGE_SIZE,
        },
      });
      items.push(...(batch || []));

      if (!batch || batch.length < TRAKT_SYNC_PAGE_SIZE) {
        return items;
      }
      page += 1;
    }
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
    mediaType: TraktFetchMediaType = 'all',
    options: {
      limit?: number;
      page?: number;
      extended?: 'min' | 'full';
      sortBy?: TraktListSortBy;
    } = {}
  ): Promise<TraktPaginatedItems> {
    const ref = String(listRef || '').trim();
    if (!ref) {
      throw new Error('listRef is required');
    }

    const itemTypes = this.listItemTypes(mediaType);
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const page = Math.max(1, options.page ?? 1);
    const extended = options.extended ?? 'min';
    const path = listUser
      ? `/users/${listUser}/lists/${ref}/items/${itemTypes}`
      : `/lists/${ref}/items/${itemTypes}`;

    const fetchPage = async (traktPage: number): Promise<TraktListEntry[]> => {
      const config = {
        params: {
          limit,
          page: traktPage,
          extended,
        },
      };
      return this.accessToken
        ? await this.getAuthenticatedOrPublic<TraktListEntry[]>(path, config)
        : await this.get<TraktListEntry[]>(path, config, 300);
    };

    if (!options.sortBy) {
      const payload = await fetchPage(page);
      const items = this.normalizeListItems(payload);
      return {
        items,
        hasMore: items.length >= limit,
      };
    }

    return this.fetchSortedListItems(fetchPage, {
      page,
      limit,
      sortBy: options.sortBy,
      cacheKey: `${path}:sorted`,
    });
  }

  public async getWatchlistItems(
    listUser = 'me',
    mediaType: TraktFetchMediaType = 'all',
    options: { limit?: number; page?: number; extended?: 'min' | 'full' } = {}
  ): Promise<TraktPaginatedItems> {
    await this.ensureFreshToken();
    const user = (listUser || 'me').trim() || 'me';
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const page = Math.max(1, options.page ?? 1);
    const extended = options.extended ?? 'min';

    if (mediaType !== 'all') {
      const traktType = mediaType === 'movie' ? 'movies' : 'shows';
      return this.fetchSingleTypePage(`/users/${user}/watchlist/${traktType}`, {
        limit,
        page,
        extended,
      });
    }

    return this.fetchMergedMediaPages(
      (type, streamPage, streamLimit) =>
        this.getAuthenticated<TraktListEntry[]>(
          `/users/${user}/watchlist/${type}`,
          {
            params: {
              limit: streamLimit,
              page: streamPage,
              extended,
            },
          }
        ),
      { limit, page }
    );
  }

  /**
   * Recent watch history (chronological). Uses /sync/history which returns
   * the authenticated user's most recent plays first.
   */
  public async getHistoryItems(
    mediaType: TraktFetchMediaType = 'all',
    options: { limit?: number; page?: number; extended?: 'min' | 'full' } = {}
  ): Promise<TraktPaginatedItems> {
    await this.ensureFreshToken();
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const page = Math.max(1, options.page ?? 1);
    const extended = options.extended ?? 'min';

    if (mediaType !== 'all') {
      const traktType = mediaType === 'movie' ? 'movies' : 'shows';
      return this.fetchSingleTypePage(`/sync/history/${traktType}`, {
        limit,
        page,
        extended,
      });
    }

    return this.fetchMergedMediaPages(
      (type, streamPage, streamLimit) =>
        this.getAuthenticated<TraktListEntry[]>(`/sync/history/${type}`, {
          params: {
            limit: streamLimit,
            page: streamPage,
            extended,
          },
        }),
      { limit, page }
    );
  }

  private async fetchSingleTypePage(
    path: string,
    options: { limit: number; page: number; extended: 'min' | 'full' }
  ): Promise<TraktPaginatedItems> {
    const payload = await this.getAuthenticated<TraktListEntry[]>(path, {
      params: {
        limit: options.limit,
        page: options.page,
        extended: options.extended,
      },
    });
    const items = this.normalizeListItems(payload);
    return {
      items,
      hasMore: items.length >= options.limit,
    };
  }

  /**
   * Fetch up to `page * limit` from movies and shows, merge by listed_at /
   * watched_at, dedupe, then return the requested page slice.
   */
  private async fetchMergedMediaPages(
    fetchTypePage: (
      type: 'movies' | 'shows',
      page: number,
      limit: number
    ) => Promise<TraktListEntry[] | undefined>,
    options: { limit: number; page: number }
  ): Promise<TraktPaginatedItems> {
    const needed = options.page * options.limit;
    const [movies, shows] = await Promise.all([
      this.collectTypePrefix(fetchTypePage, 'movies', needed, options.limit),
      this.collectTypePrefix(fetchTypePage, 'shows', needed, options.limit),
    ]);

    return mergeAndPaginateTraktItems(movies.items, shows.items, {
      page: options.page,
      limit: options.limit,
      movieHasMore: movies.hasMore,
      tvHasMore: shows.hasMore,
    });
  }

  private async collectTypePrefix(
    fetchTypePage: (
      type: 'movies' | 'shows',
      page: number,
      limit: number
    ) => Promise<TraktListEntry[] | undefined>,
    type: 'movies' | 'shows',
    needed: number,
    pageSize: number
  ): Promise<TraktPaginatedItems> {
    const items: TraktMediaItem[] = [];
    const seen = new Set<string>();
    let page = 1;
    let hasMore = false;

    while (items.length < needed) {
      const payload = await fetchTypePage(type, page, pageSize);
      const batch = this.normalizeListItems(payload);
      if (!batch.length) {
        hasMore = false;
        break;
      }

      for (const entry of batch) {
        const key = `${entry.mediaType}:${entry.tmdbId}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        items.push(entry);
        if (items.length >= needed) {
          break;
        }
      }

      if (batch.length < pageSize) {
        hasMore = false;
        break;
      }

      hasMore = true;
      if (items.length >= needed) {
        break;
      }
      page++;
    }

    return {
      items: items.slice(0, needed),
      hasMore: hasMore && items.length >= needed,
    };
  }

  private applyTokens(
    payload: TraktTokenResponse
  ): TraktTokenResponse & { expiresAt: number } {
    this.accessToken = payload.access_token || this.accessToken;
    this.refreshToken = payload.refresh_token || this.refreshToken;
    const expiresIn = Number(payload.expires_in || 0);
    if (expiresIn) {
      const createdAt = Number(payload.created_at || 0);
      this.expiresAt =
        (Number.isFinite(createdAt) && createdAt > 0
          ? createdAt
          : Math.floor(Date.now() / 1000)) + expiresIn;
    }

    this.syncAuthorizationHeaders();

    return {
      ...payload,
      expiresAt: this.expiresAt,
    };
  }

  private applyTokenState(tokens: TraktTokenState): void {
    this.accessToken = tokens.accessToken;
    this.refreshToken = tokens.refreshToken;
    this.expiresAt = tokens.expiresAt;
    this.syncAuthorizationHeaders();
  }

  private syncAuthorizationHeaders(): void {
    // Keep the cached/public client in sync for authenticated public-list calls.
    (this as unknown as { axios: AxiosInstance }).axios.defaults.headers.common[
      'Authorization'
    ] = `Bearer ${this.accessToken}`;
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
    config?: {
      params?: Record<string, string | number>;
      headers?: Record<string, string>;
    }
  ): Promise<T> {
    return this.requestWithRetry<T>('GET', endpoint, config);
  }

  private async getAuthenticatedOrPublic<T>(
    endpoint: string,
    config?: {
      params?: Record<string, string | number>;
      headers?: Record<string, string>;
    }
  ): Promise<T> {
    try {
      return await this.getAuthenticated<T>(endpoint, config);
    } catch (e) {
      if (e instanceof TraktRateLimitedError) {
        throw e;
      }
      // Fall back to app-key-only for public lists if user token fails
      logger.debug('Authenticated Trakt request failed; retrying publicly', {
        label: 'Trakt API',
        endpoint,
        errorMessage: e instanceof Error ? e.message : 'unknown error',
      });
      assertTraktCircuitClosed();
      return this.get<T>(endpoint, config, TRAKT_GET_CACHE_TTL_SECONDS);
    }
  }

  private authCacheConfig(config?: {
    params?: Record<string, string | number>;
    headers?: Record<string, string>;
  }): {
    params?: Record<string, string | number>;
    headers?: Record<string, string>;
  } {
    return {
      ...config,
      headers: {
        ...config?.headers,
        // Namespace authenticated cache entries per token so private lists
        // never leak across linked accounts.
        'x-trakt-cache-scope': this.accessToken
          ? `auth:${this.accessToken.slice(-16)}`
          : 'public',
      },
    };
  }

  private async requestWithRetry<T>(
    method: 'GET' | 'POST',
    endpoint: string,
    config?: { params?: Record<string, string | number>; data?: unknown },
    retryAuth = true,
    retryRateLimit = true
  ): Promise<T> {
    await this.ensureFreshToken();
    assertTraktCircuitClosed();

    const cacheConfig =
      method === 'GET' ? this.authCacheConfig(config) : undefined;
    if (cacheConfig) {
      const cached = this.getCached<T>(endpoint, cacheConfig);
      if (cached !== undefined) {
        return cached;
      }
    }

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
        if (cacheConfig) {
          this.setCached(
            endpoint,
            response.data,
            TRAKT_GET_CACHE_TTL_SECONDS,
            cacheConfig
          );
        }
        return response.data;
      }

      if (response.status === 429) {
        const retryAfter = this.parseRetryAfter(
          response.headers['retry-after'] as string | undefined
        );
        if (retryRateLimit && retryAfter <= TRAKT_RETRY_AFTER_MAX_SECONDS) {
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
        openTraktCircuit(retryAfter || TRAKT_CIRCUIT_FALLBACK_SECONDS);
        throw new TraktRateLimitedError(
          retryAfter ||
            remainingCircuitSeconds() ||
            TRAKT_CIRCUIT_FALLBACK_SECONDS
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
      if (
        e instanceof TraktRateLimitedError ||
        e instanceof TraktReconnectRequiredError ||
        e instanceof TraktRefreshRejectedError ||
        (e instanceof Error && e.message.startsWith('Trakt API'))
      ) {
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

  private headerValue(headers: unknown, name: string): string | undefined {
    if (!headers || typeof headers !== 'object') {
      return undefined;
    }
    const map = headers as {
      get?: (headerName: string) => unknown;
      [key: string]: unknown;
    };
    const raw = map.get?.(name) ?? map[name] ?? map[name.toLowerCase()];
    if (Array.isArray(raw)) {
      return String(raw[0] ?? '');
    }
    return raw == null ? undefined : String(raw);
  }

  private listItemTypes(mediaType: TraktFetchMediaType): string {
    if (mediaType === 'movie') return 'movies';
    if (mediaType === 'tv') return 'shows';
    if (mediaType === 'all') return 'movies,shows';
    throw new Error("mediaType must be 'movie', 'tv', or 'all'");
  }

  private async fetchSortedListItems(
    fetchPage: (page: number) => Promise<TraktListEntry[] | undefined>,
    options: {
      page: number;
      limit: number;
      sortBy: TraktListSortBy;
      cacheKey: string;
    }
  ): Promise<TraktPaginatedItems> {
    type SortedPool = { items: TraktMediaItem[]; hasMoreUpstream: boolean };
    const cacheConfig = this.authCacheConfig({
      params: {
        sortBy: options.sortBy,
        limit: options.limit,
        pool: 'sorted-list',
      },
    });
    const cachedPool = this.getCached<SortedPool>(
      options.cacheKey,
      cacheConfig
    );
    if (cachedPool) {
      return paginateSortedTraktItems(cachedPool.items, {
        page: options.page,
        limit: options.limit,
        sortBy: options.sortBy,
        hasMoreUpstream: cachedPool.hasMoreUpstream,
      });
    }

    const collected: TraktMediaItem[] = [];
    const seen = new Set<string>();
    let traktPage = 1;
    let hasMoreUpstream = false;
    const maxPages = 10;

    while (traktPage <= maxPages) {
      const payload = await fetchPage(traktPage);
      const batch = this.normalizeListItems(payload);
      if (!batch.length) {
        hasMoreUpstream = false;
        break;
      }

      for (const entry of batch) {
        const key = `${entry.mediaType}:${entry.tmdbId}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        collected.push(entry);
      }

      if (batch.length < options.limit) {
        hasMoreUpstream = false;
        break;
      }

      hasMoreUpstream = true;
      traktPage++;
    }

    this.setCached(
      options.cacheKey,
      { items: collected, hasMoreUpstream } satisfies SortedPool,
      TRAKT_GET_CACHE_TTL_SECONDS,
      cacheConfig
    );

    return paginateSortedTraktItems(collected, {
      page: options.page,
      limit: options.limit,
      sortBy: options.sortBy,
      hasMoreUpstream,
    });
  }

  private normalizeMediaItem(
    item: TraktMediaObject | undefined,
    mediaType: 'movie' | 'tv'
  ): TraktMediaItem | null {
    if (!item?.ids?.tmdb) {
      return null;
    }
    const communityRating =
      item.rating != null && Number.isFinite(Number(item.rating))
        ? Number(item.rating)
        : undefined;
    return {
      tmdbId: Number(item.ids.tmdb),
      mediaType,
      title: item.title || item.name || '',
      year: item.year,
      ...(communityRating != null
        ? { traktCommunityRating: communityRating }
        : {}),
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
      const media = entry.movie || entry.show;
      const sortAt = entry.listed_at || entry.watched_at;
      items.push({
        ...normalized,
        ...(sortAt ? { traktAddedAt: sortAt } : {}),
        ...(media?.released || media?.first_aired
          ? {
              traktReleaseDate: media.released || media.first_aired,
            }
          : {}),
      });
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
