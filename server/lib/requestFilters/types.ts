export interface RequestProfileRoute {
  serverId: number | null;
  profileId: number | null;
  rootFolder: string | null;
  languageProfileId?: number | null;
}

export interface RequestProfileRouting {
  defaultMovie: RequestProfileRoute;
  defaultTv: RequestProfileRoute;
  animeMovie: RequestProfileRoute;
  animeTv: RequestProfileRoute;
}

export const EMPTY_PROFILE_ROUTE: RequestProfileRoute = {
  serverId: null,
  profileId: null,
  rootFolder: null,
  languageProfileId: null,
};

export const DEFAULT_PROFILE_ROUTING: RequestProfileRouting = {
  defaultMovie: { ...EMPTY_PROFILE_ROUTE },
  defaultTv: { ...EMPTY_PROFILE_ROUTE },
  animeMovie: { ...EMPTY_PROFILE_ROUTE },
  animeTv: { ...EMPTY_PROFILE_ROUTE },
};

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
   * @deprecated Use profileRouting.animeTv.serverId
   */
  animeSonarrServerId: number | null;
  /**
   * @deprecated Use profileRouting.animeTv.serverId on a 4K Sonarr instance
   */
  animeSonarrServerId4k: number | null;
  /** Optional Radarr/Sonarr server, profile, and folder overrides per media kind. */
  profileRouting: RequestProfileRouting;
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
  profileRouting: { ...DEFAULT_PROFILE_ROUTING },
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

export const hasProfileRouteConfig = (route: RequestProfileRoute): boolean =>
  route.serverId != null ||
  route.profileId != null ||
  route.rootFolder != null ||
  route.languageProfileId != null;

export const normalizeProfileRoute = (
  route: Partial<RequestProfileRoute> | undefined
): RequestProfileRoute => ({
  serverId: route?.serverId ?? null,
  profileId: route?.profileId ?? null,
  rootFolder: route?.rootFolder?.trim() ? route.rootFolder.trim() : null,
  languageProfileId: route?.languageProfileId ?? null,
});

export const normalizeProfileRouting = (
  routing: Partial<RequestProfileRouting> | undefined
): RequestProfileRouting => ({
  defaultMovie: normalizeProfileRoute(routing?.defaultMovie),
  defaultTv: normalizeProfileRoute(routing?.defaultTv),
  animeMovie: normalizeProfileRoute(routing?.animeMovie),
  animeTv: normalizeProfileRoute(routing?.animeTv),
});
