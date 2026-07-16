import type TheMovieDb from '@server/api/themoviedb';
import type TraktAPI from '@server/api/trakt';
import { TRAKT_RECOMMENDATIONS_LIMIT_MAX } from '@server/api/trakt';
import type { TraktMediaItem } from '@server/api/trakt/interfaces';
import cacheManager from '@server/lib/cache';
import { applyTraktMediaTypeFilter } from '@server/lib/trakt/animeFilter';
import {
  filterWatchedTraktItems,
  loadWatchedIdSets,
} from '@server/lib/trakt/hideWatched';

export const TRAKT_RECOMMENDATIONS_ITEMS_PER_PAGE = 20;

export interface TraktRecommendationQueryOptions {
  mediaType: 'movie' | 'tv' | 'both' | 'anime';
  ignoreCollected: boolean;
  ignoreWatchlisted: boolean;
  ignoreWatched: boolean;
}

async function fetchRawTraktRecommendations(
  trakt: TraktAPI,
  mediaType: 'movie' | 'tv' | 'both',
  options: Pick<
    TraktRecommendationQueryOptions,
    'ignoreCollected' | 'ignoreWatchlisted'
  >
): Promise<TraktMediaItem[]> {
  const recommendationOptions = {
    limit: TRAKT_RECOMMENDATIONS_LIMIT_MAX,
    ignoreCollected: options.ignoreCollected,
    ignoreWatchlisted: options.ignoreWatchlisted,
  };

  if (mediaType === 'both') {
    const [movies, shows] = await Promise.all([
      trakt.getRecommendations('movie', recommendationOptions),
      trakt.getRecommendations('tv', recommendationOptions),
    ]);
    const items: TraktMediaItem[] = [];
    const maxLen = Math.max(movies.length, shows.length);
    for (let i = 0; i < maxLen; i++) {
      if (movies[i]) {
        items.push(movies[i]);
      }
      if (shows[i]) {
        items.push(shows[i]);
      }
    }
    return items;
  }

  return trakt.getRecommendations(mediaType, recommendationOptions);
}

function recommendationsCacheKey(
  userId: number,
  options: TraktRecommendationQueryOptions
): string {
  return `recommendations:${userId}:${options.mediaType}:${options.ignoreCollected}:${options.ignoreWatchlisted}:${options.ignoreWatched}`;
}

export async function getTraktRecommendationItems(
  userId: number,
  trakt: TraktAPI,
  tmdb: TheMovieDb,
  options: TraktRecommendationQueryOptions
): Promise<TraktMediaItem[]> {
  const cache = cacheManager.getCache('trakt');
  const cacheKey = recommendationsCacheKey(userId, options);
  const cached = cache.data.get<TraktMediaItem[]>(cacheKey);
  if (cached) {
    return cached;
  }

  const fetchType =
    options.mediaType === 'anime'
      ? 'tv'
      : options.mediaType === 'both'
        ? 'both'
        : options.mediaType;

  let items = await fetchRawTraktRecommendations(trakt, fetchType, options);
  items = await applyTraktMediaTypeFilter(items, options.mediaType, tmdb);

  if (options.ignoreWatched) {
    const watchedSets = await loadWatchedIdSets(userId, trakt);
    items = filterWatchedTraktItems(items, watchedSets);
  }

  cache.data.set(cacheKey, items);
  return items;
}

export function paginateTraktRecommendationItems<T>(
  items: T[],
  page: number,
  itemsPerPage = TRAKT_RECOMMENDATIONS_ITEMS_PER_PAGE
): {
  pageItems: T[];
  totalPages: number;
  totalResults: number;
} {
  const safePage = Math.max(1, page);
  const offset = (safePage - 1) * itemsPerPage;

  return {
    pageItems: items.slice(offset, offset + itemsPerPage),
    totalPages: Math.max(1, Math.ceil(items.length / itemsPerPage)),
    totalResults: items.length,
  };
}
