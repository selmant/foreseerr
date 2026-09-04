import type TheMovieDb from '@server/api/themoviedb';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import { hasDiscoverTmdbId } from './unmapped';
import { tmdbPosterPath } from './validity';

/**
 * Put the TMDB poster the confirm probe already fetched onto a list tile.
 * Moonfin (and any client that is not TmdbTitleCard) draws `posterPath`
 * from the list payload and will not call `/movie/{id}` per card.
 */
export async function withTmdbPoster(
  item: WatchlistItem,
  tmdb?: TheMovieDb
): Promise<WatchlistItem> {
  if (item.posterPath || !hasDiscoverTmdbId(item.tmdbId) || !item.mediaType) {
    return item;
  }
  const posterPath = await tmdbPosterPath(item.mediaType, item.tmdbId, tmdb);
  return posterPath ? { ...item, posterPath } : item;
}

export async function withTmdbPosters(
  items: WatchlistItem[],
  tmdb?: TheMovieDb
): Promise<WatchlistItem[]> {
  return Promise.all(items.map((item) => withTmdbPoster(item, tmdb)));
}
