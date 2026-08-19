import ExternalAPI from '@server/api/externalapi';
import cacheManager from '@server/lib/cache';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import {
  MdblistListNotFoundError,
  MdblistNotConfiguredError,
  MdblistUnavailableError,
  collectMdblistListItems,
  mapMdblistListItems,
  mapMdblistPublicLists,
  normalizeMdblistListMetadata,
  parseMdblistListRef,
  type MdblistDiscoverItem,
  type MdblistListItemPayload,
  type MdblistListItemsPayload,
  type MdblistListMetadata,
  type MdblistListRef,
  type MdblistPublicList,
} from './lists';
import { parseMdblistRatings } from './parse';
import type { MdblistMediaPayload, ParsedMdblistRatings } from './types';

export {
  MdblistListNotFoundError,
  MdblistNotConfiguredError,
  MdblistUnavailableError,
  formatMdblistListReference,
  mapMdblistListItems,
  mapMdblistPublicLists,
  parseMdblistListRef,
} from './lists';
export type {
  MdblistDiscoverItem,
  MdblistListRef,
  MdblistPublicList,
} from './lists';
export { parseMdblistRatings } from './parse';
export type { ParsedMdblistRatings } from './types';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRateLimited = (error: unknown): boolean => {
  const status = (error as { response?: { status?: number } })?.response
    ?.status;
  return status === 429 || status === 503;
};

const isQuotaExceeded = (error: unknown): boolean =>
  (error as { response?: { status?: number } })?.response?.status === 429;

const getHeaderValue = (headers: unknown, name: string): unknown => {
  const headerBag = headers as {
    get?: (headerName: string) => unknown;
    [key: string]: unknown;
  };
  return (
    headerBag?.get?.(name) ??
    headerBag?.[name] ??
    headerBag?.[name.toLowerCase()]
  );
};

const getResetAfterMs = (headers: unknown): number | undefined => {
  const reset = Number(getHeaderValue(headers, 'x-ratelimit-reset'));
  if (!Number.isFinite(reset)) return undefined;

  const resetMs = reset > 1_000_000_000 ? reset * 1000 : reset;
  return Math.max(1000, resetMs - Date.now());
};

const getRetryAfterMs = (error: unknown): number | undefined => {
  const headers = (error as { response?: { headers?: unknown } })?.response
    ?.headers;
  const retryAfter = getHeaderValue(headers, 'retry-after');

  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
    return Math.max(1000, retryAfter * 1000);
  }

  if (typeof retryAfter === 'string') {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.max(1000, seconds * 1000);
    }

    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) {
      return Math.max(1000, timestamp - Date.now());
    }
  }

  return getResetAfterMs(headers);
};

type CircuitState = 'closed' | 'open' | 'half-open';

const CIRCUIT_FAILURE_THRESHOLD = 1;
const CIRCUIT_OPEN_TIMEOUT_MS = 60_000;

export type MdblistMetricsSnapshot = {
  singleFetches: number;
  batchFetches: number;
  cacheHits: number;
  rateLimits: number;
  failures: number;
};

const mdblistMetrics: MdblistMetricsSnapshot = {
  singleFetches: 0,
  batchFetches: 0,
  cacheHits: 0,
  rateLimits: 0,
  failures: 0,
};

export const getMdblistMetrics = (): MdblistMetricsSnapshot => ({
  ...mdblistMetrics,
});

/** Test helper — reset in-process MDBList counters. */
export const resetMdblistMetrics = (): void => {
  mdblistMetrics.singleFetches = 0;
  mdblistMetrics.batchFetches = 0;
  mdblistMetrics.cacheHits = 0;
  mdblistMetrics.rateLimits = 0;
  mdblistMetrics.failures = 0;
};

const recordMdblistMetric = (
  key: keyof MdblistMetricsSnapshot,
  count = 1
): void => {
  mdblistMetrics[key] += count;
};

export const MDBLIST_HOT_RATINGS_TTL_SECONDS = 86400;
export const MDBLIST_WARM_RATINGS_TTL_SECONDS = 86400 * 7;
export const MDBLIST_COLD_RATINGS_TTL_SECONDS = 86400 * 30;
export const MDBLIST_LIST_SEARCH_TTL_SECONDS = 15 * 60;
export const MDBLIST_LIST_ITEMS_TTL_SECONDS = 60 * 60;

export interface MdblistBatchRatingsItem {
  tmdbId: number;
  cacheTtlSeconds?: number;
}

/**
 * Shared MDBList client for cache and retry state across concurrent lookups.
 */
class MdblistAPI extends ExternalAPI {
  private static instance: MdblistAPI | null = null;
  private static instanceKey = '';

  private apiKey: string;
  private circuitState: CircuitState = 'closed';
  private circuitFailures = 0;
  private circuitOpenedAt = 0;
  private circuitOpenTimeoutMs = CIRCUIT_OPEN_TIMEOUT_MS;
  private halfOpenProbeInFlight = false;
  private requestQueue: Promise<void> = Promise.resolve();

  constructor(apiKey?: string) {
    const settings = getSettings();
    const key = (apiKey ?? settings.mdblist?.apiKey ?? '').trim();

    super(
      'https://api.mdblist.com',
      { apikey: key },
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        // Ratings use an explicit age-based TTL in getRatings.
        nodeCache: cacheManager.getCache('mdblist').data,
      }
    );

    this.apiKey = key;
    this.axios.interceptors.response.use((response) => {
      const remaining = Number(
        getHeaderValue(response.headers, 'x-ratelimit-remaining')
      );
      if (Number.isFinite(remaining) && remaining <= 0) {
        this.openCircuit(getResetAfterMs(response.headers));
      }
      return response;
    });
  }

  public static getInstance(): MdblistAPI {
    const key = (getSettings().mdblist?.apiKey ?? '').trim();
    if (!MdblistAPI.instance || MdblistAPI.instanceKey !== key) {
      MdblistAPI.instance = new MdblistAPI(key);
      MdblistAPI.instanceKey = key;
    }
    return MdblistAPI.instance;
  }

  /** Test helper — drop the shared client between cases. */
  public static resetInstance(): void {
    MdblistAPI.instance = null;
    MdblistAPI.instanceKey = '';
  }

  public isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * Validate the configured key with a stable, inexpensive title lookup.
   * Health checks must throw on failure so callers can distinguish an invalid
   * key from a title that simply has no aggregated ratings.
   */
  public async validateApiKey(): Promise<void> {
    if (!this.apiKey) {
      throw new Error('MDBList API key is not configured');
    }

    await this.get<MdblistMediaPayload>('/tmdb/movie/550', undefined, 0);
  }

  private acquireCircuitSlot(): 'allowed' | 'probe' | 'blocked' {
    if (this.circuitState === 'closed') {
      return 'allowed';
    }

    if (
      this.circuitState === 'open' &&
      Date.now() - this.circuitOpenedAt >= this.circuitOpenTimeoutMs
    ) {
      this.circuitState = 'half-open';
      this.halfOpenProbeInFlight = false;
    }

    if (this.circuitState === 'half-open') {
      if (this.halfOpenProbeInFlight) {
        return 'blocked';
      }
      this.halfOpenProbeInFlight = true;
      return 'probe';
    }

    return 'blocked';
  }

  private closeCircuit(): void {
    this.circuitState = 'closed';
    this.circuitFailures = 0;
    this.circuitOpenedAt = 0;
    this.circuitOpenTimeoutMs = CIRCUIT_OPEN_TIMEOUT_MS;
    this.halfOpenProbeInFlight = false;
  }

  private openCircuit(cooldownMs = CIRCUIT_OPEN_TIMEOUT_MS): void {
    this.circuitFailures += 1;
    if (this.circuitFailures < CIRCUIT_FAILURE_THRESHOLD) return;

    this.circuitState = 'open';
    this.circuitOpenedAt = Date.now();
    this.circuitOpenTimeoutMs = cooldownMs;
    this.halfOpenProbeInFlight = false;
    recordMdblistMetric('rateLimits');
    logger.warn('MDBList circuit opened after rate limit', {
      label: 'MDBList',
      cooldownMs,
      nextProbeAt: new Date(this.circuitOpenedAt + cooldownMs).toISOString(),
    });
  }

  /**
   * Run cache misses one at a time so a quota response can open the circuit
   * before already-queued title-card requests reach MDBList.
   */
  private async queueRequest<T>(request: () => Promise<T>): Promise<T> {
    const previous = this.requestQueue;
    let release: () => void = () => undefined;
    this.requestQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await request();
    } finally {
      release();
    }
  }

  /**
   * Fetch aggregated multi-source ratings for a TMDb item.
   * Returns null when unavailable, unconfigured, or the request fails.
   */
  public async getRatings(
    mediaType: 'movie' | 'tv',
    tmdbId: number,
    cacheTtlSeconds = MDBLIST_COLD_RATINGS_TTL_SECONDS
  ): Promise<ParsedMdblistRatings | null> {
    if (!this.apiKey || !tmdbId) {
      return null;
    }

    return this.queueRequest(() =>
      this.fetchRatings(mediaType, tmdbId, cacheTtlSeconds)
    );
  }

  private async fetchRatings(
    mediaType: 'movie' | 'tv',
    tmdbId: number,
    cacheTtlSeconds: number
  ): Promise<ParsedMdblistRatings | null> {
    const circuitSlot = this.acquireCircuitSlot();
    if (circuitSlot === 'blocked') {
      return null;
    }

    const providerType = mediaType === 'tv' ? 'show' : 'movie';
    const endpoint = `/tmdb/${providerType}/${tmdbId}`;
    const cached = this.getCached<MdblistMediaPayload>(endpoint);
    if (cached) {
      recordMdblistMetric('cacheHits');
      logger.debug('MDBList ratings cache hit', {
        label: 'MDBList',
        mediaType,
        tmdbId,
        kind: 'single',
      });
      if (circuitSlot === 'probe') this.closeCircuit();
      return parseMdblistRatings(cached);
    }

    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        recordMdblistMetric('singleFetches');
        const data = await this.get<MdblistMediaPayload>(
          endpoint,
          undefined,
          cacheTtlSeconds
        );

        if (!data || typeof data !== 'object' || data.error) {
          if (circuitSlot === 'probe') this.closeCircuit();
          return null;
        }

        if (circuitSlot === 'probe') this.closeCircuit();
        return parseMdblistRatings(data);
      } catch (e) {
        if (isQuotaExceeded(e)) {
          this.openCircuit(getRetryAfterMs(e));
          return null;
        }

        if (isRateLimited(e) && attempt < maxAttempts) {
          recordMdblistMetric('rateLimits');
          const backoffMs = 400 * attempt * attempt;
          logger.debug('MDBList rate limited; retrying', {
            label: 'MDBList',
            mediaType,
            tmdbId,
            attempt,
            backoffMs,
          });
          await sleep(backoffMs);
          continue;
        }

        if (circuitSlot === 'probe') {
          this.openCircuit();
        }

        recordMdblistMetric('failures');
        // 404 / network — degrade gracefully (callers fall back or hide badges)
        logger.debug('MDBList ratings unavailable', {
          label: 'MDBList',
          mediaType,
          tmdbId,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
        return null;
      }
    }

    return null;
  }

  /** Resolve a poster collection with MDBList's official multi-ID endpoint. */
  public async getBatchRatings(
    mediaType: 'movie' | 'tv',
    items: MdblistBatchRatingsItem[]
  ): Promise<Map<number, ParsedMdblistRatings | null>> {
    if (!this.apiKey || !items.length) {
      return new Map();
    }

    return this.queueRequest(() => this.fetchBatchRatings(mediaType, items));
  }

  private async fetchBatchRatings(
    mediaType: 'movie' | 'tv',
    items: MdblistBatchRatingsItem[]
  ): Promise<Map<number, ParsedMdblistRatings | null>> {
    const providerType = mediaType === 'tv' ? 'show' : 'movie';
    const uniqueItems = [
      ...new Map(items.map((item) => [item.tmdbId, item])).values(),
    ];
    const results = new Map<number, ParsedMdblistRatings | null>();
    const missing = uniqueItems.filter((item) => {
      const endpoint = `/tmdb/${providerType}/${item.tmdbId}`;
      const cached = this.getCached<MdblistMediaPayload>(endpoint);
      if (!cached) {
        return true;
      }
      recordMdblistMetric('cacheHits');
      results.set(item.tmdbId, parseMdblistRatings(cached));
      return false;
    });

    if (!missing.length) {
      logger.debug('MDBList batch ratings cache hit', {
        label: 'MDBList',
        mediaType,
        itemCount: uniqueItems.length,
        cacheHits: uniqueItems.length,
      });
      return results;
    }

    logger.debug('MDBList batch ratings fetch', {
      label: 'MDBList',
      mediaType,
      itemCount: missing.length,
      cacheHits: uniqueItems.length - missing.length,
    });

    const circuitSlot = this.acquireCircuitSlot();
    if (circuitSlot === 'blocked') {
      for (const item of missing) results.set(item.tmdbId, null);
      return results;
    }

    try {
      recordMdblistMetric('batchFetches');
      const payloads = await this.post<MdblistMediaPayload[]>(
        `/tmdb/${providerType}/`,
        { ids: missing.map((item) => item.tmdbId) },
        undefined,
        0
      );

      if (circuitSlot === 'probe') this.closeCircuit();
      const ttlById = new Map(
        missing.map((item) => [
          item.tmdbId,
          item.cacheTtlSeconds ?? MDBLIST_COLD_RATINGS_TTL_SECONDS,
        ])
      );
      for (const payload of payloads ?? []) {
        const tmdbId = payload.ids?.tmdb;
        if (!tmdbId || !ttlById.has(tmdbId)) continue;
        this.setCached(
          `/tmdb/${providerType}/${tmdbId}`,
          payload,
          ttlById.get(tmdbId)
        );
        results.set(tmdbId, parseMdblistRatings(payload));
      }
    } catch (e) {
      if (isQuotaExceeded(e)) {
        this.openCircuit(getRetryAfterMs(e));
      } else {
        if (circuitSlot === 'probe') this.openCircuit();
        recordMdblistMetric('failures');
        logger.debug('MDBList batch ratings unavailable', {
          label: 'MDBList',
          mediaType,
          itemCount: missing.length,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      }
    }

    for (const item of missing) {
      if (!results.has(item.tmdbId)) results.set(item.tmdbId, null);
    }
    return results;
  }

  public async searchLists(query: string): Promise<MdblistPublicList[]> {
    if (!this.apiKey) {
      throw new MdblistNotConfiguredError();
    }

    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    return this.queueRequest(async () => {
      const payload = await this.queuedGet<unknown>(
        '/lists/search',
        { params: { query: trimmed } },
        MDBLIST_LIST_SEARCH_TTL_SECONDS,
        'search lists'
      );
      return mapMdblistPublicLists(payload);
    });
  }

  public async getListItems(
    refInput: string,
    options: { limit: number; offset: number }
  ): Promise<{
    title: string;
    items: MdblistDiscoverItem[];
    hasMore: boolean;
  }> {
    if (!this.apiKey) {
      throw new MdblistNotConfiguredError();
    }

    const ref = parseMdblistListRef(refInput);
    const limit = Math.max(1, options.limit);
    const offset = Math.max(0, options.offset);

    return this.queueRequest(async () => {
      const metadata = await this.fetchListMetadata(ref);
      const title =
        metadata[0]?.name ||
        (ref.kind === 'slug' ? ref.slug : String(ref.listId));
      const payload = await this.fetchListItemsPayload(ref, limit, offset);
      const rawCount = collectMdblistListItems(payload).length;

      return {
        title,
        items: mapMdblistListItems(payload),
        hasMore: rawCount >= limit,
      };
    });
  }

  private listPath(ref: MdblistListRef): string {
    if (ref.kind === 'id') {
      return `/lists/${ref.listId}`;
    }
    return `/lists/${encodeURIComponent(ref.username)}/${encodeURIComponent(
      ref.slug
    )}`;
  }

  private async fetchListMetadata(
    ref: MdblistListRef
  ): Promise<MdblistListMetadata[]> {
    try {
      const payload = await this.queuedGet<unknown>(
        this.listPath(ref),
        undefined,
        MDBLIST_LIST_ITEMS_TTL_SECONDS,
        'list metadata'
      );
      return normalizeMdblistListMetadata(payload);
    } catch (e) {
      if (e instanceof MdblistListNotFoundError) {
        throw e;
      }
      logger.debug('MDBList list metadata unavailable', {
        label: 'MDBList',
        ref,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      return [];
    }
  }

  private async fetchListItemsPayload(
    ref: MdblistListRef,
    limit: number,
    offset: number
  ): Promise<MdblistListItemsPayload | MdblistListItemPayload[]> {
    return this.queuedGet<MdblistListItemsPayload | MdblistListItemPayload[]>(
      `${this.listPath(ref)}/items`,
      { params: { limit, offset } },
      MDBLIST_LIST_ITEMS_TTL_SECONDS,
      'list items'
    );
  }

  private async queuedGet<T>(
    endpoint: string,
    config: { params?: Record<string, unknown> } | undefined,
    ttl: number,
    context: string
  ): Promise<T> {
    const circuitSlot = this.acquireCircuitSlot();
    if (circuitSlot === 'blocked') {
      throw new MdblistUnavailableError();
    }

    const cached = this.getCached<T>(endpoint, config);
    if (cached !== undefined) {
      recordMdblistMetric('cacheHits');
      if (circuitSlot === 'probe') this.closeCircuit();
      return cached;
    }

    try {
      recordMdblistMetric('singleFetches');
      const data = await this.get<T>(endpoint, config, ttl);
      if (circuitSlot === 'probe') this.closeCircuit();
      return data;
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response
        ?.status;

      if (isQuotaExceeded(e)) {
        this.openCircuit(getRetryAfterMs(e));
        throw new MdblistUnavailableError('MDBList daily quota exceeded');
      }

      if (circuitSlot === 'probe') {
        this.openCircuit();
      }

      recordMdblistMetric('failures');
      logger.debug(`MDBList ${context} unavailable`, {
        label: 'MDBList',
        endpoint,
        errorMessage: e instanceof Error ? e.message : String(e),
      });

      if (status === 404) {
        throw new MdblistListNotFoundError();
      }

      throw new MdblistUnavailableError(
        e instanceof Error ? e.message : `Unable to ${context}`
      );
    }
  }
}

export default MdblistAPI;
