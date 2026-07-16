import ExternalAPI from '@server/api/externalapi';
import cacheManager from '@server/lib/cache';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { parseMdblistRatings } from './parse';
import type { MdblistMediaPayload, ParsedMdblistRatings } from './types';

export { parseMdblistRatings } from './parse';
export type { ParsedMdblistRatings } from './types';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRateLimited = (error: unknown): boolean => {
  const status = (error as { response?: { status?: number } })?.response
    ?.status;
  return status === 429 || status === 503;
};

/**
 * Shared MDBList client. Creating a new instance per call used to give each
 * call its own axios-rate-limit bucket, so batch×N concurrency blew past the
 * remote quota (429) and title cards fell back to TMDB-only badges.
 */
class MdblistAPI extends ExternalAPI {
  private static instance: MdblistAPI | null = null;
  private static instanceKey = '';

  private apiKey: string;

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
        // Ratings move slowly — 48h default (see cache.ts + getRatings ttl)
        nodeCache: cacheManager.getCache('mdblist').data,
        // Keep local pacing under typical MDBList free-tier limits.
        rateLimit: {
          maxRPS: 3,
          maxRequests: 3,
        },
      }
    );

    this.apiKey = key;
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
   * Fetch aggregated multi-source ratings for a TMDb item.
   * Returns null when unavailable, unconfigured, or the request fails.
   */
  public async getRatings(
    mediaType: 'movie' | 'tv',
    tmdbId: number
  ): Promise<ParsedMdblistRatings | null> {
    if (!this.apiKey || !tmdbId) {
      return null;
    }

    const providerType = mediaType === 'tv' ? 'show' : 'movie';
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const data = await this.get<MdblistMediaPayload>(
          `/tmdb/${providerType}/${tmdbId}`,
          undefined,
          86400 * 2
        );

        if (!data || typeof data !== 'object' || data.error) {
          return null;
        }

        return parseMdblistRatings(data);
      } catch (e) {
        if (isRateLimited(e) && attempt < maxAttempts) {
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
}

export default MdblistAPI;
