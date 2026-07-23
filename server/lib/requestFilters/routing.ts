import { MediaType } from '@server/constants/media';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import type { RequestProfileRoute, RequestRoutingSettings } from './types';
import { hasProfileRouteConfig, normalizeProfileRouting } from './types';

export class RequestRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestRoutingError';
  }
}

export type RequestRoutingOverrides = {
  serverId?: number | null;
  profileId?: number | null;
  rootFolder?: string | null;
  languageProfileId?: number | null;
  tags?: number[] | null;
};

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

const routeForRequest = (
  routing: RequestRoutingSettings,
  kind: RequestRouteKind
): RequestProfileRoute => normalizeProfileRouting(routing.profileRouting)[kind];

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

const isProvided = <T>(value: T | null | undefined): value is T =>
  value !== null && value !== undefined;

const routeAppliesToServer = (
  route: RequestProfileRoute,
  serverId: number
): boolean => route.serverId == null || route.serverId === serverId;

const collectKnownProfileIds = (
  server: RadarrSettings | SonarrSettings,
  routingSettings: RequestRoutingSettings
): Set<number> => {
  const ids = new Set<number>([server.activeProfileId]);

  if ('activeAnimeProfileId' in server && server.activeAnimeProfileId != null) {
    ids.add(server.activeAnimeProfileId);
  }

  const routing = normalizeProfileRouting(routingSettings.profileRouting);
  for (const route of Object.values(routing) as RequestProfileRoute[]) {
    if (route.profileId != null && routeAppliesToServer(route, server.id)) {
      ids.add(route.profileId);
    }
  }

  return ids;
};

const collectKnownRootFolders = (
  server: RadarrSettings | SonarrSettings,
  routingSettings: RequestRoutingSettings
): Set<string> => {
  const folders = new Set<string>([server.activeDirectory]);

  if ('activeAnimeDirectory' in server && server.activeAnimeDirectory) {
    folders.add(server.activeAnimeDirectory);
  }

  const routing = normalizeProfileRouting(routingSettings.profileRouting);
  for (const route of Object.values(routing) as RequestProfileRoute[]) {
    if (route.rootFolder && routeAppliesToServer(route, server.id)) {
      folders.add(route.rootFolder);
    }
  }

  return folders;
};

const collectKnownLanguageProfileIds = (
  server: SonarrSettings
): Set<number> => {
  const ids = new Set<number>();

  if (server.activeLanguageProfileId != null) {
    ids.add(server.activeLanguageProfileId);
  }
  if (server.activeAnimeLanguageProfileId != null) {
    ids.add(server.activeAnimeLanguageProfileId);
  }

  return ids;
};

const collectKnownTags = (
  server: SonarrSettings | RadarrSettings,
  useAnimeDefaults: boolean
): Set<number> => {
  if (useAnimeDefaults && 'animeTags' in server && server.animeTags?.length) {
    return new Set(server.animeTags);
  }

  return new Set(server.tags ?? []);
};

const sonarrDefaults = (
  server: SonarrSettings,
  useAnimeDefaults: boolean
): Pick<
  ResolvedRequestRouting,
  'profileId' | 'rootFolder' | 'languageProfileId' | 'tags' | 'seriesType'
> => {
  if (useAnimeDefaults) {
    return {
      profileId: server.activeAnimeProfileId ?? server.activeProfileId,
      rootFolder: server.activeAnimeDirectory ?? server.activeDirectory,
      languageProfileId:
        server.activeAnimeLanguageProfileId ?? server.activeLanguageProfileId,
      tags: server.animeTags?.length
        ? [...server.animeTags]
        : server.tags
          ? [...server.tags]
          : [],
      seriesType: server.animeSeriesType ?? 'anime',
    };
  }

  return {
    profileId: server.activeProfileId,
    rootFolder: server.activeDirectory,
    languageProfileId: server.activeLanguageProfileId,
    tags: server.tags ? [...server.tags] : [],
    seriesType: server.seriesType,
  };
};

const radarrDefaults = (
  server: RadarrSettings
): Pick<ResolvedRequestRouting, 'profileId' | 'rootFolder' | 'tags'> => ({
  profileId: server.activeProfileId,
  rootFolder: server.activeDirectory,
  tags: server.tags ? [...server.tags] : [],
});

const validateResolvedRouting = ({
  server,
  mediaType,
  useAnimeDefaults,
  routing,
  profileId,
  rootFolder,
  languageProfileId,
  tags,
  explicit,
}: {
  server: RadarrSettings | SonarrSettings;
  mediaType: MediaType.MOVIE | MediaType.TV;
  useAnimeDefaults: boolean;
  routing: RequestRoutingSettings;
  profileId: number | undefined;
  rootFolder: string | undefined;
  languageProfileId: number | undefined;
  tags: number[] | undefined;
  explicit: RequestRoutingOverrides;
}): void => {
  if (profileId != null) {
    const knownProfiles = collectKnownProfileIds(server, routing);
    if (!knownProfiles.has(profileId)) {
      throw new RequestRoutingError(
        'Selected quality profile is not valid for the chosen server.'
      );
    }
  }

  if (rootFolder) {
    const knownFolders = collectKnownRootFolders(server, routing);
    if (!knownFolders.has(rootFolder)) {
      throw new RequestRoutingError(
        'Selected root folder is not valid for the chosen server.'
      );
    }
  }

  if (mediaType === MediaType.TV && languageProfileId != null) {
    const knownLanguageProfiles = collectKnownLanguageProfileIds(
      server as SonarrSettings
    );
    if (!knownLanguageProfiles.has(languageProfileId)) {
      throw new RequestRoutingError(
        'Selected language profile is not valid for the chosen server.'
      );
    }
  }

  if (tags?.length) {
    const knownTags = collectKnownTags(server, useAnimeDefaults);
    if (tags.some((tag) => !knownTags.has(tag))) {
      throw new RequestRoutingError(
        'Selected tags are not valid for the chosen server.'
      );
    }
  }

  if (isProvided(explicit.serverId) && explicit.serverId !== server.id) {
    throw new RequestRoutingError(
      'Selected server is not available for this request.'
    );
  }
};

export const resolveAtomicRequestRouting = ({
  mediaType,
  isAnime,
  is4k,
  routing,
  radarr,
  sonarr,
  overrides = {},
}: {
  mediaType: MediaType.MOVIE | MediaType.TV;
  isAnime: boolean;
  is4k: boolean;
  routing: RequestRoutingSettings;
  radarr: RadarrSettings[];
  sonarr: SonarrSettings[];
  overrides?: RequestRoutingOverrides;
}): ResolvedRequestRouting => {
  const kind = routeKindFor(mediaType, isAnime);
  const route = routeForRequest(routing, kind);
  const explicitServerId = overrides.serverId;

  const server =
    mediaType === MediaType.MOVIE
      ? ((isProvided(explicitServerId)
          ? findServerById(radarr, explicitServerId, is4k)
          : undefined) ??
        findServerById(radarr, route.serverId, is4k) ??
        findDefaultServer(radarr, is4k))
      : ((isProvided(explicitServerId)
          ? findServerById(sonarr, explicitServerId, is4k)
          : undefined) ??
        findServerById(sonarr, route.serverId, is4k) ??
        findDefaultServer(sonarr, is4k));

  if (!server) {
    throw new RequestRoutingError('No server configured for this request.');
  }

  if (isProvided(explicitServerId) && server.id !== explicitServerId) {
    throw new RequestRoutingError(
      'Selected server is not available for this request.'
    );
  }

  const useAnimeDefaults =
    mediaType === MediaType.TV && isAnime && kind === 'animeTv';
  const useRouteConfig =
    explicitServerId == null &&
    hasProfileRouteConfig(route) &&
    routeAppliesToServer(route, server.id);

  if (mediaType === MediaType.MOVIE) {
    const radarrServer = server as RadarrSettings;
    const defaults = radarrDefaults(radarrServer);

    let profileId = defaults.profileId;
    let rootFolder = defaults.rootFolder;
    let tags = defaults.tags;

    if (useRouteConfig) {
      profileId = route.profileId ?? profileId;
      rootFolder = route.rootFolder ?? rootFolder;
    }

    if (isProvided(overrides.profileId)) {
      profileId = overrides.profileId;
    }
    if (isProvided(overrides.rootFolder) && overrides.rootFolder !== '') {
      rootFolder = overrides.rootFolder;
    }
    if (overrides.tags != null) {
      tags = [...overrides.tags];
    }

    validateResolvedRouting({
      server: radarrServer,
      mediaType,
      useAnimeDefaults: false,
      routing,
      profileId,
      rootFolder,
      languageProfileId: undefined,
      tags,
      explicit: overrides,
    });

    return {
      kind,
      serverId: radarrServer.id,
      profileId,
      rootFolder,
      languageProfileId: undefined,
      tags,
      radarrServer,
    };
  }

  const sonarrServer = server as SonarrSettings;
  const defaults = sonarrDefaults(sonarrServer, useAnimeDefaults);

  let profileId = defaults.profileId;
  let rootFolder = defaults.rootFolder;
  let languageProfileId = defaults.languageProfileId;
  let tags = defaults.tags;
  const seriesType = defaults.seriesType;

  if (useRouteConfig) {
    profileId = route.profileId ?? profileId;
    rootFolder = route.rootFolder ?? rootFolder;
    languageProfileId = route.languageProfileId ?? languageProfileId;
  }

  if (isProvided(overrides.profileId)) {
    profileId = overrides.profileId;
  }
  if (isProvided(overrides.rootFolder) && overrides.rootFolder !== '') {
    rootFolder = overrides.rootFolder;
  }
  if (isProvided(overrides.languageProfileId)) {
    languageProfileId = overrides.languageProfileId;
  }
  if (overrides.tags != null) {
    tags = [...overrides.tags];
  }

  validateResolvedRouting({
    server: sonarrServer,
    mediaType,
    useAnimeDefaults,
    routing,
    profileId,
    rootFolder,
    languageProfileId,
    tags,
    explicit: overrides,
  });

  return {
    kind,
    serverId: sonarrServer.id,
    profileId,
    rootFolder,
    languageProfileId,
    tags,
    seriesType,
    sonarrServer,
  };
};

export const resolveRequestProfileRouting = ({
  mediaType,
  isAnime,
  is4k,
  routing,
  radarr,
  sonarr,
}: {
  mediaType: MediaType.MOVIE | MediaType.TV;
  isAnime: boolean;
  is4k: boolean;
  routing: RequestRoutingSettings;
  radarr: RadarrSettings[];
  sonarr: SonarrSettings[];
}): ResolvedRequestRouting | null => {
  const kind = routeKindFor(mediaType, isAnime);
  const route = routeForRequest(routing, kind);

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
  routing,
  is4k,
  isAnime,
}: {
  sonarr: SonarrSettings[];
  routing: RequestRoutingSettings;
  is4k: boolean;
  isAnime: boolean;
}): AnimeRoutingResult | null => {
  const resolved = resolveRequestProfileRouting({
    mediaType: MediaType.TV,
    isAnime,
    is4k,
    routing,
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
