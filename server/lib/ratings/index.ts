import type { ParsedMdblistRatings } from '@server/api/mdblist';
import MdblistAPI, {
  MDBLIST_COLD_RATINGS_TTL_SECONDS,
  MDBLIST_HOT_RATINGS_TTL_SECONDS,
  MDBLIST_WARM_RATINGS_TTL_SECONDS,
} from '@server/api/mdblist';
import IMDBRadarrProxy from '@server/api/rating/imdbRadarrProxy';
import RottenTomatoes from '@server/api/rating/rottentomatoes';
import type { RatingResponse } from '@server/api/ratings';
import {
  EXTERNAL_ENRICHMENT_CONCURRENCY,
  mapWithConcurrency,
} from '@server/lib/concurrency';
import { getSettings } from '@server/lib/settings';
import type { EnrichRatingsOptions } from './enrichment';
import { needsMdblistEnrichment } from './enrichment';

export {
  clearMdblistProviderState,
  needsMdblistEnrichment,
  type EnrichRatingsOptions,
} from './enrichment';

const criticsLabel = (
  score: number
): 'Certified Fresh' | 'Fresh' | 'Rotten' => {
  if (score >= 75) {
    return 'Certified Fresh';
  }
  if (score >= 60) {
    return 'Fresh';
  }
  return 'Rotten';
};

export const mapMdblistToRatingResponse = (
  parsed: ParsedMdblistRatings,
  meta: { title: string; year?: number }
): RatingResponse => {
  const ratings: RatingResponse = { provider: 'mdblist' };

  if (parsed.rtRating != null || parsed.rtUserRating != null) {
    ratings.rt = {
      title: meta.title,
      year: meta.year ?? 0,
      url: `https://www.rottentomatoes.com/search?search=${encodeURIComponent(
        meta.title
      )}`,
      ...(parsed.rtRating != null
        ? {
            criticsScore: parsed.rtRating,
            criticsRating: criticsLabel(parsed.rtRating),
          }
        : {}),
      ...(parsed.rtUserRating != null
        ? {
            audienceScore: parsed.rtUserRating,
            audienceRating:
              parsed.rtUserRating >= 60
                ? ('Upright' as const)
                : ('Spilled' as const),
          }
        : {}),
    };
  }

  if (parsed.imdbRating != null) {
    ratings.imdb = {
      title: meta.title,
      url: parsed.imdbId
        ? `https://www.imdb.com/title/${parsed.imdbId}`
        : 'https://www.imdb.com',
      criticsScore: parsed.imdbRating,
      criticsScoreCount: parsed.imdbVotes ?? 0,
    };
  }

  if (parsed.metacriticRating != null) {
    ratings.metacritic = { score: parsed.metacriticRating };
  }

  if (parsed.traktRating != null) {
    ratings.trakt = {
      rating: parsed.traktRating,
      votes: parsed.traktVotes,
    };
  }

  return ratings;
};

const hasAnyRating = (ratings: RatingResponse): boolean =>
  Boolean(ratings.rt || ratings.imdb || ratings.metacritic || ratings.trakt);

export interface FetchCombinedRatingsOptions {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  title: string;
  year?: number;
  releaseDate?: string | null;
  imdbId?: string | null;
}

/** Recent titles change ratings frequently; older titles can be refreshed less often. */
export const getRatingsCacheTtl = (releaseDate?: string | null): number => {
  if (!releaseDate) {
    return MDBLIST_HOT_RATINGS_TTL_SECONDS;
  }

  const releaseTime = Date.parse(releaseDate);
  if (!Number.isFinite(releaseTime)) {
    return MDBLIST_HOT_RATINGS_TTL_SECONDS;
  }

  const now = Date.now();
  const threeMonthsAgo = now - 90 * 86400 * 1000;
  const twoYearsAgo = now - 730 * 86400 * 1000;

  if (releaseTime >= threeMonthsAgo) {
    return MDBLIST_HOT_RATINGS_TTL_SECONDS;
  }
  if (releaseTime >= twoYearsAgo) {
    return MDBLIST_WARM_RATINGS_TTL_SECONDS;
  }
  return MDBLIST_COLD_RATINGS_TTL_SECONDS;
};

/**
 * Prefer MDBList when configured; otherwise fall back to legacy RT (+ IMDB for movies).
 */
export const fetchCombinedRatings = async ({
  mediaType,
  tmdbId,
  title,
  year,
  releaseDate,
  imdbId,
}: FetchCombinedRatingsOptions): Promise<RatingResponse | null> => {
  const settings = getSettings();
  const mdblistConfigured = Boolean(settings.mdblist?.apiKey?.trim());

  if (mdblistConfigured) {
    const mdblist = MdblistAPI.getInstance();
    const parsed = await mdblist.getRatings(
      mediaType,
      tmdbId,
      getRatingsCacheTtl(releaseDate)
    );
    if (parsed) {
      const mapped = mapMdblistToRatingResponse(parsed, { title, year });
      if (hasAnyRating(mapped)) {
        return mapped;
      }
    }
    // MDBList miss — do not fall through to scrapers when MDBList is the
    // configured source (avoids dual-provider fan-out; Pillar C rule).
    return null;
  }

  const rtapi = new RottenTomatoes();
  const rtratings =
    mediaType === 'movie'
      ? await rtapi.getMovieRatings(title, year ?? 0)
      : await rtapi.getTVRatings(title, year);

  let imdbRatings;
  if (mediaType === 'movie' && imdbId) {
    const imdbApi = new IMDBRadarrProxy();
    imdbRatings = await imdbApi.getMovieRatings(imdbId);
  }

  if (!rtratings && !imdbRatings) {
    return null;
  }

  return {
    provider: 'legacy',
    ...(rtratings ? { rt: rtratings } : {}),
    ...(imdbRatings ? { imdb: imdbRatings } : {}),
  };
};

export type RatingsBatchItem = {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  title?: string;
  year?: number;
  releaseDate?: string | null;
};

export type RatingsBatchResult = RatingsBatchItem & {
  ratings: RatingResponse | null;
};

/**
 * Concurrent multi-item ratings fetch (MDBList-oriented grids).
 */
export const fetchBatchCombinedRatings = async (
  items: RatingsBatchItem[]
): Promise<RatingsBatchResult[]> => {
  const settings = getSettings();
  if (settings.mdblist?.apiKey?.trim()) {
    const mdblist = MdblistAPI.getInstance();
    const byMediaType = {
      movie: items.filter((item) => item.mediaType === 'movie'),
      tv: items.filter((item) => item.mediaType === 'tv'),
    };
    const parsedMaps = new Map<
      'movie' | 'tv',
      Map<number, ParsedMdblistRatings | null>
    >();

    await Promise.all(
      (['movie', 'tv'] as const).map(async (mediaType) => {
        const groupedItems = byMediaType[mediaType];
        if (!groupedItems.length) return;
        parsedMaps.set(
          mediaType,
          await mdblist.getBatchRatings(
            mediaType,
            groupedItems.map((item) => ({
              tmdbId: item.tmdbId,
              cacheTtlSeconds: getRatingsCacheTtl(item.releaseDate),
            }))
          )
        );
      })
    );

    return items.map((item) => {
      const parsed = parsedMaps.get(item.mediaType)?.get(item.tmdbId);
      const ratings = parsed
        ? mapMdblistToRatingResponse(parsed, {
            title:
              item.title || (item.mediaType === 'movie' ? 'Movie' : 'Series'),
            year: item.year,
          })
        : null;
      return {
        ...item,
        ratings: ratings && hasAnyRating(ratings) ? ratings : null,
      };
    });
  }

  return mapWithConcurrency(
    items,
    EXTERNAL_ENRICHMENT_CONCURRENCY,
    async (item) => ({
      mediaType: item.mediaType,
      tmdbId: item.tmdbId,
      title: item.title,
      year: item.year,
      releaseDate: item.releaseDate,
      ratings: await fetchCombinedRatings({
        mediaType: item.mediaType,
        tmdbId: item.tmdbId,
        title: item.title || (item.mediaType === 'movie' ? 'Movie' : 'Series'),
        year: item.year,
        releaseDate: item.releaseDate,
      }),
    })
  );
};

type RatingResult = {
  id: number;
  mediaType?: string;
  title?: string;
  name?: string;
  releaseDate?: string | null;
  firstAirDate?: string | null;
  ratings?: RatingResponse | null;
};

/** Merge external ratings into the same result objects that carry posters. */
export const enrichResultsWithRatings = async <T extends RatingResult>(
  results: T[],
  options?: EnrichRatingsOptions
): Promise<T[]> => {
  if (!options?.force && !needsMdblistEnrichment(options?.query)) {
    return results;
  }

  const candidates = results.filter(
    (result) =>
      (result.mediaType === 'movie' || result.mediaType === 'tv') &&
      (!options?.skipExisting || result.ratings === undefined)
  );
  if (!candidates.length || !getSettings().mdblist?.apiKey?.trim()) {
    return results;
  }

  const batch = await fetchBatchCombinedRatings(
    candidates.map((result) => {
      const releaseDate =
        result.mediaType === 'movie' ? result.releaseDate : result.firstAirDate;
      return {
        mediaType: result.mediaType as 'movie' | 'tv',
        tmdbId: result.id,
        title: result.title ?? result.name,
        releaseDate,
        year: releaseDate ? Number(String(releaseDate).slice(0, 4)) : undefined,
      };
    })
  );
  const ratingsByKey = new Map(
    batch.map((item) => [`${item.mediaType}:${item.tmdbId}`, item.ratings])
  );

  return results.map((result) =>
    result.mediaType === 'movie' || result.mediaType === 'tv'
      ? {
          ...result,
          ratings: ratingsByKey.get(`${result.mediaType}:${result.id}`) ?? null,
        }
      : result
  );
};
