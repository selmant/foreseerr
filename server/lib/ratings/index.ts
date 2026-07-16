import type { ParsedMdblistRatings } from '@server/api/mdblist';
import MdblistAPI from '@server/api/mdblist';
import IMDBRadarrProxy from '@server/api/rating/imdbRadarrProxy';
import RottenTomatoes from '@server/api/rating/rottentomatoes';
import type { RatingResponse } from '@server/api/ratings';
import {
  EXTERNAL_ENRICHMENT_CONCURRENCY,
  mapWithConcurrency,
} from '@server/lib/concurrency';
import { getSettings } from '@server/lib/settings';

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
  imdbId?: string | null;
}

/**
 * Prefer MDBList when configured; otherwise fall back to legacy RT (+ IMDB for movies).
 */
export const fetchCombinedRatings = async ({
  mediaType,
  tmdbId,
  title,
  year,
  imdbId,
}: FetchCombinedRatingsOptions): Promise<RatingResponse | null> => {
  const settings = getSettings();
  const mdblistConfigured = Boolean(settings.mdblist?.apiKey?.trim());

  if (mdblistConfigured) {
    const mdblist = MdblistAPI.getInstance();
    const parsed = await mdblist.getRatings(mediaType, tmdbId);
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
  return mapWithConcurrency(
    items,
    EXTERNAL_ENRICHMENT_CONCURRENCY,
    async (item) => ({
      mediaType: item.mediaType,
      tmdbId: item.tmdbId,
      title: item.title,
      year: item.year,
      ratings: await fetchCombinedRatings({
        mediaType: item.mediaType,
        tmdbId: item.tmdbId,
        title: item.title || (item.mediaType === 'movie' ? 'Movie' : 'Series'),
        year: item.year,
      }),
    })
  );
};
