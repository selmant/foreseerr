import { MediaType } from '@server/constants/media';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import type { RequestFiltersSettings, RequestProfileRoute } from './types';
import { hasProfileRouteConfig, normalizeProfileRouting } from './types';

export type RequestRouteKind =
  | 'defaultMovie'
  | 'defaultTv'
  | 'animeMovie'
  | 'animeTv';

export type ResolvedRequestRouting = {
  kind: RequestRouteKind;
  serverId: number | null;
  profileId: number | undefined;
  rootFolder: string | undefined;
  languageProfileId: number | undefined;
  tags: number[] | undefined;
  seriesType?: SonarrSettings['animeSeriesType'] | 'anime' | 'standard';
  radarrServer?: RadarrSettings;
  sonarrServer?: SonarrSettings;
};

const routeKindFor = (
  mediaType: MediaType.MOVIE | MediaType.TV,
  isAnime: boolean
): RequestRouteKind => {
  if (mediaType === MediaType.MOVIE) {
    return isAnime ? 'animeMovie' : 'defaultMovie';
  }
  return isAnime ? 'animeTv' : 'defaultTv';
};

const legacyAnimeTvServerId = (
  filters: RequestFiltersSettings,
  is4k: boolean
): number | null =>
  is4k ? filters.animeSonarrServerId4k : filters.animeSonarrServerId;

const effectiveAnimeTvRoute = (
  filters: RequestFiltersSettings,
  is4k: boolean
): RequestProfileRoute => {
  const route = normalizeProfileRouting(filters.profileRouting).animeTv;
  if (route.serverId != null || hasProfileRouteConfig(route)) {
    return route;
  }
  const legacyServerId = legacyAnimeTvServerId(filters, is4k);
  if (legacyServerId != null) {
    return { ...route, serverId: legacyServerId };
  }
  return route;
};

const routeForRequest = (
  filters: RequestFiltersSettings,
  kind: RequestRouteKind,
  is4k: boolean
): RequestProfileRoute => {
  const routing = normalizeProfileRouting(filters.profileRouting);
  if (kind === 'animeTv') {
    return effectiveAnimeTvRoute(filters, is4k);
  }
  return routing[kind];
};

const findDefaultServer = <T extends { isDefault: boolean; is4k: boolean }>(
  servers: T[],
  is4k: boolean
): T | undefined =>
  servers.find((server) => server.isDefault && server.is4k === is4k);

const findServerById = <T extends { id: number; is4k: boolean }>(
  servers: T[],
  serverId: number | null | undefined,
  is4k: boolean
): T | undefined => {
  if (serverId == null) {
    return undefined;
  }
  return servers.find(
    (server) => server.id === serverId && server.is4k === is4k
  );
};

const resolveRadarrRouting = ({
  route,
  kind,
  radarr,
  is4k,
}: {
  route: RequestProfileRoute;
  kind: RequestRouteKind;
  radarr: RadarrSettings[];
  is4k: boolean;
}): ResolvedRequestRouting | null => {
  if (!hasProfileRouteConfig(route)) {
    return null;
  }

  const server =
    findServerById(radarr, route.serverId, is4k) ??
    findDefaultServer(radarr, is4k);

  if (!server) {
    return null;
  }

  return {
    kind,
    serverId: server.id,
    profileId: route.profileId ?? server.activeProfileId,
    rootFolder: route.rootFolder ?? server.activeDirectory,
    languageProfileId: undefined,
    tags: server.tags ? [...server.tags] : [],
    radarrServer: server,
  };
};

const resolveSonarrRouting = ({
  route,
  kind,
  sonarr,
  is4k,
  isAnime,
}: {
  route: RequestProfileRoute;
  kind: RequestRouteKind;
  sonarr: SonarrSettings[];
  is4k: boolean;
  isAnime: boolean;
}): ResolvedRequestRouting | null => {
  const shouldApply =
    hasProfileRouteConfig(route) || (isAnime && kind === 'animeTv');

  if (!shouldApply) {
    return null;
  }

  const server =
    findServerById(sonarr, route.serverId, is4k) ??
    findDefaultServer(sonarr, is4k);

  if (!server) {
    return null;
  }

  const useAnimeDefaults = isAnime && kind === 'animeTv';

  return {
    kind,
    serverId: server.id,
    profileId:
      route.profileId ??
      (useAnimeDefaults
        ? (server.activeAnimeProfileId ?? server.activeProfileId)
        : server.activeProfileId),
    rootFolder:
      route.rootFolder ??
      (useAnimeDefaults
        ? (server.activeAnimeDirectory ?? server.activeDirectory)
        : server.activeDirectory),
    languageProfileId:
      route.languageProfileId ??
      (useAnimeDefaults
        ? (server.activeAnimeLanguageProfileId ??
          server.activeLanguageProfileId)
        : server.activeLanguageProfileId),
    tags: useAnimeDefaults
      ? server.animeTags
        ? [...server.animeTags]
        : server.tags
          ? [...server.tags]
          : []
      : server.tags
        ? [...server.tags]
        : [],
    seriesType: useAnimeDefaults
      ? (server.animeSeriesType ?? 'anime')
      : server.seriesType,
    sonarrServer: server,
  };
};

export const resolveRequestProfileRouting = ({
  mediaType,
  isAnime,
  is4k,
  filters,
  radarr,
  sonarr,
}: {
  mediaType: MediaType.MOVIE | MediaType.TV;
  isAnime: boolean;
  is4k: boolean;
  filters: RequestFiltersSettings;
  radarr: RadarrSettings[];
  sonarr: SonarrSettings[];
}): ResolvedRequestRouting | null => {
  const kind = routeKindFor(mediaType, isAnime);
  const route = routeForRequest(filters, kind, is4k);

  if (mediaType === MediaType.MOVIE) {
    return resolveRadarrRouting({ route, kind, radarr, is4k });
  }

  return resolveSonarrRouting({
    route,
    kind,
    sonarr,
    is4k,
    isAnime,
  });
};

/** @deprecated Use resolveRequestProfileRouting */
export type AnimeRoutingResult = {
  server: SonarrSettings | null;
  serverId: number | null;
  profileId: number | undefined;
  rootFolder: string | undefined;
  languageProfileId: number | undefined;
  tags: number[] | undefined;
  seriesType: SonarrSettings['animeSeriesType'] | 'anime';
};

/** @deprecated Use resolveRequestProfileRouting */
export const resolveAnimeSonarrRouting = ({
  sonarr,
  filters,
  is4k,
  isAnime,
}: {
  sonarr: SonarrSettings[];
  filters: RequestFiltersSettings;
  is4k: boolean;
  isAnime: boolean;
}): AnimeRoutingResult | null => {
  const resolved = resolveRequestProfileRouting({
    mediaType: MediaType.TV,
    isAnime,
    is4k,
    filters,
    radarr: [],
    sonarr,
  });

  if (!resolved?.sonarrServer) {
    return null;
  }

  return {
    server: resolved.sonarrServer,
    serverId: resolved.serverId,
    profileId: resolved.profileId,
    rootFolder: resolved.rootFolder,
    languageProfileId: resolved.languageProfileId,
    tags: resolved.tags,
    seriesType: resolved.seriesType ?? 'anime',
  };
};

export const applyResolvedRoutingToRequest = (
  routing: ResolvedRequestRouting | null,
  current: {
    serverId?: number | null;
    profileId?: number | null;
    rootFolder?: string | null;
    languageProfileId?: number | null;
    tags?: number[] | null;
  }
): void => {
  if (!routing) {
    return;
  }

  if (current.serverId == null && routing.serverId != null) {
    current.serverId = routing.serverId;
  }
  if (current.profileId == null && routing.profileId != null) {
    current.profileId = routing.profileId;
  }
  if (
    (current.rootFolder == null || current.rootFolder === '') &&
    routing.rootFolder
  ) {
    current.rootFolder = routing.rootFolder;
  }
  if (current.languageProfileId == null && routing.languageProfileId != null) {
    current.languageProfileId = routing.languageProfileId;
  }
  if (current.tags == null && routing.tags?.length) {
    current.tags = routing.tags;
  }
};
