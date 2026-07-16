export interface RequestFiltersSettings {
  /** When false, Discover quality filters are skipped entirely. */
  enabled: boolean;
  /** Minimum TMDB vote average on a 0–10 scale. Null disables. */
  tmdbThreshold: number | null;
  tmdbMinVotes: number | null;
  /** Minimum IMDb rating on a 0–10 scale (MDBList). Null disables. */
  imdbThreshold: number | null;
  imdbMinVotes: number | null;
  /** Minimum Rotten Tomatoes critics score 0–100 (MDBList). Null disables. */
  rtCriticsThreshold: number | null;
  /** Minimum Rotten Tomatoes audience score 0–100 (MDBList). Null disables. */
  rtAudienceThreshold: number | null;
  /** Minimum Metacritic score 0–100 (MDBList). Null disables. */
  metacriticThreshold: number | null;
  /** Minimum Trakt community rating 0–10 (MDBList). Null disables. */
  traktThreshold: number | null;
  /** Allow titles missing the required rating/vote fields. */
  includeNoRating: boolean;
  /** Earliest release / first-air year. Null disables. */
  minReleaseYear: number | null;
  /** Hide titles that include any of these TMDB genre ids. */
  excludedGenreIds: number[];
  /**
   * Optional dedicated Sonarr server id for anime (non-4K).
   * Null = default Sonarr server with that server's anime profile/folder.
   */
  animeSonarrServerId: number | null;
  /** Optional dedicated Sonarr server id for anime 4K requests. */
  animeSonarrServerId4k: number | null;
}

export const DEFAULT_REQUEST_FILTERS: RequestFiltersSettings = {
  enabled: false,
  tmdbThreshold: null,
  tmdbMinVotes: null,
  imdbThreshold: null,
  imdbMinVotes: null,
  rtCriticsThreshold: null,
  rtAudienceThreshold: null,
  metacriticThreshold: null,
  traktThreshold: null,
  includeNoRating: true,
  minReleaseYear: null,
  excludedGenreIds: [],
  animeSonarrServerId: null,
  animeSonarrServerId4k: null,
};

/** True when any gate needs MDBList / combined ratings. */
export const needsMdblistRatings = (
  settings: RequestFiltersSettings
): boolean =>
  settings.imdbThreshold != null ||
  settings.imdbMinVotes != null ||
  settings.rtCriticsThreshold != null ||
  settings.rtAudienceThreshold != null ||
  settings.metacriticThreshold != null ||
  settings.traktThreshold != null;

/** True when any quality filter field is configured. */
export const hasAnyQualityGate = (settings: RequestFiltersSettings): boolean =>
  settings.enabled &&
  (settings.tmdbThreshold != null ||
    settings.tmdbMinVotes != null ||
    needsMdblistRatings(settings) ||
    settings.minReleaseYear != null ||
    settings.excludedGenreIds.length > 0);
