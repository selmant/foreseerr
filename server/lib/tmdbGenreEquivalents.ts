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
