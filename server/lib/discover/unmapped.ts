import { parseDiscoverTruthyQuery } from '@server/lib/discover/filterOptions';

export function hasDiscoverTmdbId(
  tmdbId: number | null | undefined
): tmdbId is number {
  return typeof tmdbId === 'number' && Number.isFinite(tmdbId) && tmdbId > 0;
}

export function shouldHideUnmappedFromQuery(query: {
  hideUnmapped?: unknown;
}): boolean {
  return parseDiscoverTruthyQuery(query.hideUnmapped);
}

export function omitUnmappedDiscoverItems<T extends { tmdbId?: number | null }>(
  items: T[],
  hideUnmapped: boolean
): T[] {
  if (!hideUnmapped) {
    return items;
  }
  return items.filter((item) => hasDiscoverTmdbId(item.tmdbId));
}

export function anilistSourceUrl(anilistId: number): string {
  return `https://anilist.co/anime/${anilistId}`;
}

export function traktSourceUrl(
  mediaType: 'movie' | 'tv',
  slugOrId: string | number
): string {
  return `https://trakt.tv/${mediaType === 'movie' ? 'movies' : 'shows'}/${slugOrId}`;
}

export function imdbSourceUrl(imdbId: string): string {
  return `https://www.imdb.com/title/${imdbId}`;
}

export function tmdbSourceUrl(
  mediaType: 'movie' | 'tv',
  tmdbId: number
): string {
  return `https://www.themoviedb.org/${mediaType}/${tmdbId}`;
}
