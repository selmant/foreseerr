/**
 * TMDB keeps separate movie vs TV genre catalogs. Mixed lists (Trending,
 * Trakt) often show movie names in the filter while series use different IDs.
 * Expand a selected ID to the related movie/TV pair so "Action" matches
 * "Action & Adventure", "Science Fiction" matches "Sci-Fi & Fantasy", etc.
 */
const TMDB_GENRE_EQUIVALENTS: Record<number, readonly number[]> = {
  28: [10759], // Action → Action & Adventure
  12: [10759], // Adventure → Action & Adventure
  10759: [28, 12], // Action & Adventure → Action, Adventure
  14: [10765], // Fantasy → Sci-Fi & Fantasy
  878: [10765], // Science Fiction → Sci-Fi & Fantasy
  10765: [14, 878], // Sci-Fi & Fantasy → Fantasy, Science Fiction
  10752: [10768], // War → War & Politics
  10768: [10752], // War & Politics → War
  10751: [10762], // Family → Kids
  10762: [10751], // Kids → Family
};

const TMDB_MOVIE_GENRE_IDS = new Set([
  28, 12, 16, 35, 80, 99, 18, 10751, 14, 36, 27, 10402, 9648, 10749, 878, 10770,
  53, 10752, 37,
]);

const TMDB_TV_GENRE_IDS = new Set([
  10759, 16, 35, 80, 99, 18, 10751, 10762, 9648, 10763, 10764, 10765, 10766,
  10767, 10768, 37,
]);

const catalogGenreIds = (catalog: 'movie' | 'tv'): Set<number> =>
  catalog === 'movie' ? TMDB_MOVIE_GENRE_IDS : TMDB_TV_GENRE_IDS;

const parseGenreIds = (genre?: string): number[] => {
  if (!genre) {
    return [];
  }
  return genre
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isFinite(id));
};

export const expandTmdbGenreIds = (genreIds: number[]): number[] => {
  const expanded = new Set<number>();
  for (const id of genreIds) {
    if (!Number.isFinite(id)) {
      continue;
    }
    expanded.add(id);
    for (const related of TMDB_GENRE_EQUIVALENTS[id] ?? []) {
      expanded.add(related);
    }
  }
  return [...expanded];
};

/**
 * TMDB Discover treats comma as AND. Mixed movie+TV default IDs (or a TV-only
 * ID on /discover/movies) would otherwise match nothing. Map each selected ID
 * onto the target catalog, OR-ing equivalents, then AND the original picks.
 */
export const toTmdbDiscoverGenres = (
  genre: string | undefined,
  catalog: 'movie' | 'tv'
): string | undefined => {
  const ids = parseGenreIds(genre);
  if (!ids.length) {
    return undefined;
  }
  const allowed = catalogGenreIds(catalog);
  const groups = ids
    .map((id) =>
      [...new Set([id, ...(TMDB_GENRE_EQUIVALENTS[id] ?? [])])].filter(
        (related) => allowed.has(related)
      )
    )
    .filter((group) => group.length > 0)
    .map((group) => group.join('|'));
  return groups.length ? groups.join(',') : undefined;
};
