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

export interface RequestRoutingSettings {
  /** Optional Radarr/Sonarr server, profile, and folder overrides per media kind. */
  profileRouting: RequestProfileRouting;
}

export const DEFAULT_REQUEST_ROUTING: RequestRoutingSettings = {
  profileRouting: { ...DEFAULT_PROFILE_ROUTING },
};

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
