import ExternalAPI from '@server/api/externalapi';
import cacheManager from '@server/lib/cache';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { parseMdblistRatings } from './parse';
import type { MdblistMediaPayload, ParsedMdblistRatings } from './types';

export { parseMdblistRatings } from './parse';
export type { ParsedMdblistRatings } from './types';

class MdblistAPI extends ExternalAPI {
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
        // Ratings move slowly — 12h matches RT/IMDB caches
        nodeCache: cacheManager.getCache('mdblist').data,
        rateLimit: {
          maxRPS: 5,
          maxRequests: 40,
        },
      }
    );

    this.apiKey = key;
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

    try {
      const data = await this.get<MdblistMediaPayload>(
        `/tmdb/${providerType}/${tmdbId}`,
        undefined,
        43200
      );

      if (!data || typeof data !== 'object' || data.error) {
        return null;
      }

      return parseMdblistRatings(data);
    } catch (e) {
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
}

export default MdblistAPI;
