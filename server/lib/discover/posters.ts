import type TheMovieDb from '@server/api/themoviedb';
import {
  PROVIDER_ROW_CONCURRENCY,
  mapWithConcurrency,
} from '@server/lib/concurrency';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import { hasDiscoverTmdbId } from './unmapped';
import { tmdbTileArt } from './validity';

/**
 * Put the TMDB poster, backdrop, release/first-air date, and score
 * (`voteAverage`) the confirm probe already fetched onto a list tile. Moonfin (and any client that is not
 * TmdbTitleCard) draws these from the list payload and will not call
 * `/movie/{id}` per card.
 *
 * A tile that already carries a poster has been through here (or brought its
 * own art) and is left alone.
 */
export async function withTmdbPoster(
  item: WatchlistItem,
  tmdb?: TheMovieDb
): Promise<WatchlistItem> {
  if (item.posterPath || !hasDiscoverTmdbId(item.tmdbId) || !item.mediaType) {
    return item;
  }
  const art = await tmdbTileArt(item.mediaType, item.tmdbId, tmdb);
  return {
    ...item,
    ...(art.posterPath ? { posterPath: art.posterPath } : {}),
    ...(art.backdropPath ? { backdropPath: art.backdropPath } : {}),
    ...(item.mediaType === 'movie' && art.releaseDate
      ? { releaseDate: art.releaseDate }
      : {}),
    ...(item.mediaType === 'tv' && art.firstAirDate
      ? { firstAirDate: art.firstAirDate }
      : {}),
    ...(art.voteAverage !== undefined ? { voteAverage: art.voteAverage } : {}),
  };
}

export async function withTmdbPosters(
  items: WatchlistItem[],
  tmdb?: TheMovieDb
): Promise<WatchlistItem[]> {
  return mapWithConcurrency(items, PROVIDER_ROW_CONCURRENCY, (item) =>
    withTmdbPoster(item, tmdb)
  );
}
