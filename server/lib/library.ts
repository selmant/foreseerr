import type { JellyfinLibraryItemExtended } from '@server/api/jellyfin';
import JellyfinAPI from '@server/api/jellyfin';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import type {
  LibraryBrowseResponse,
  LibraryEpisode,
  LibraryFacetsResponse,
  LibraryItemInspectorResponse,
  LibrarySeasonEpisodesResponse,
  LibrarySeriesDetailResponse,
  LibrarySeriesSeason,
  LibraryShelf,
  LibraryTitle,
  LibraryWatchNowResponse,
} from '@server/interfaces/api/libraryInterfaces';
import {
  libraryItemImageUrl,
  libraryTitleDisplayFields,
  listBrowseFromClient,
} from '@server/lib/libraryBrowse';
import type { ParsedLibraryBrowseQuery } from '@server/lib/libraryBrowseQuery';
import {
  getCachedLibraryImage,
  setCachedLibraryImage,
} from '@server/lib/libraryImageCache';
import type { SeriesPlayTarget } from '@server/lib/libraryPlayTarget';
import {
  filterPlayableLibraryTitles,
  resolveSeriesPlayTarget,
} from '@server/lib/libraryPlayTarget';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { getHostname } from '@server/utils/getHostname';

const JELLYFIN_LIBRARY_TIMEOUT_MS = 15_000;
const PLAY_TARGET_CONCURRENCY = 4;

const mapLimit = async <T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> => {
  if (items.length === 0) {
    return [];
  }
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await mapper(items[index]);
      }
    })
  );
  return results;
};

const settledValue = <T>(result: PromiseSettledResult<T>, fallback: T): T =>
  result.status === 'fulfilled' ? result.value : fallback;

export const findLinkedJellyfinUser = (userId: number) =>
  getRepository(User)
    .createQueryBuilder('user')
    .addSelect([
      'user.jellyfinAuthToken',
      'user.jellyfinDeviceId',
      'user.jellyfinUserId',
    ])
    .where('user.id = :userId', { userId })
    .getOne();

export const createUserJellyfinClient = async (
  userId: number
): Promise<
  | { ok: true; client: JellyfinAPI; user: User }
  | {
      ok: false;
      code: 'not_linked' | 'unsupported_media_server';
    }
> => {
  const settings = getSettings();
  if (settings.main.mediaServerType !== MediaServerType.JELLYFIN) {
    return { ok: false, code: 'unsupported_media_server' };
  }
  const user = await findLinkedJellyfinUser(userId);
  if (
    !user?.jellyfinUserId ||
    !user.jellyfinAuthToken ||
    !user.jellyfinDeviceId
  ) {
    return { ok: false, code: 'not_linked' };
  }
  const client = new JellyfinAPI(
    getHostname(),
    user.jellyfinAuthToken,
    user.jellyfinDeviceId,
    JELLYFIN_LIBRARY_TIMEOUT_MS
  );
  client.setUserId(user.jellyfinUserId);
  return { ok: true, client, user };
};

const tmdbIdFromProviders = (
  item: JellyfinLibraryItemExtended
): number | undefined => {
  const raw = item.ProviderIds?.Tmdb ?? item.ProviderIds?.TheMovieDb;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const mediaTypeFromItem = (
  item: JellyfinLibraryItemExtended
): 'movie' | 'tv' => {
  if (item.Type === 'Movie') return 'movie';
  return 'tv';
};

export const jellyfinPlaybackUrl = (
  jellyfinHost: string,
  serverId: string,
  jellyfinItemId: string
) =>
  `${jellyfinHost.replace(/\/$/, '')}/web/index.html#!/details?id=${encodeURIComponent(
    jellyfinItemId
  )}&context=home&serverId=${encodeURIComponent(serverId)}`;

const mediaUrlForItem = (jellyfinItemId: string): string | undefined => {
  const settings = getSettings();
  const jellyfin = settings.jellyfin;
  if (!jellyfin.ip && !jellyfin.externalHostname) return undefined;
  const jellyfinHost =
    process.env.FORESEERR_RUNTIME === 'desktop' ||
    !(jellyfin.externalHostname && jellyfin.externalHostname.length > 0)
      ? getHostname()
      : jellyfin.externalHostname;
  const serverId = jellyfin.serverId ?? '';
  return jellyfinPlaybackUrl(jellyfinHost, serverId, jellyfinItemId);
};

const subtitleForItem = (
  item: JellyfinLibraryItemExtended
): string | undefined => {
  if (item.Type !== 'Episode') return undefined;
  const season = item.ParentIndexNumber;
  const episode = item.IndexNumber;
  if (season != null && episode != null) {
    return `S${season}E${episode}${
      item.SeriesName ? ` · ${item.SeriesName}` : ''
    }`;
  }
  return item.SeriesName;
};

const titleForItem = (item: JellyfinLibraryItemExtended): string => {
  if (item.Type === 'Episode') {
    return item.SeriesName || item.Name || 'Episode';
  }
  return item.Name;
};

/** Match Foreseer Media rows by jellyfin id (item or series) or TMDB id. */
const resolveMediaRows = async (
  items: JellyfinLibraryItemExtended[]
): Promise<Map<string, Media>> => {
  const jellyfinIds = [
    ...new Set(
      items
        .flatMap((i) => [i.Id, i.SeriesId])
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const mediaRepository = getRepository(Media);
  const byJellyfin =
    jellyfinIds.length === 0
      ? []
      : await mediaRepository
          .createQueryBuilder('media')
          .where(
            'media.jellyfinMediaId IN (:...ids) OR media.jellyfinMediaId4k IN (:...ids)',
            { ids: jellyfinIds }
          )
          .getMany();

  const map = new Map<string, Media>();
  for (const media of byJellyfin) {
    if (media.jellyfinMediaId) map.set(media.jellyfinMediaId, media);
    if (media.jellyfinMediaId4k) map.set(media.jellyfinMediaId4k, media);
  }

  const itemMedia = new Map<string, Media>();
  for (const item of items) {
    const media =
      map.get(item.Id) ?? (item.SeriesId ? map.get(item.SeriesId) : undefined);
    if (media) itemMedia.set(item.Id, media);
  }

  const missing = items.filter((i) => !itemMedia.has(i.Id));
  const tmdbLookups = missing
    .map((i) => {
      const tmdbId = tmdbIdFromProviders(i);
      if (!tmdbId) return null;
      return { tmdbId, mediaType: mediaTypeFromItem(i), itemId: i.Id };
    })
    .filter((x): x is NonNullable<typeof x> => x != null);

  if (tmdbLookups.length > 0) {
    const related = await Media.getRelatedMedia(
      undefined,
      tmdbLookups.map((l) => ({
        tmdbId: l.tmdbId,
        mediaType: l.mediaType,
      }))
    );
    for (const lookup of tmdbLookups) {
      const media = related.find(
        (m) => m.tmdbId === lookup.tmdbId && m.mediaType === lookup.mediaType
      );
      if (media) itemMedia.set(lookup.itemId, media);
    }
  }

  return itemMedia;
};

const progressFromItem = (
  item: JellyfinLibraryItemExtended
): number | undefined => {
  const userData = item.UserData;
  if (userData?.PlayedPercentage != null) {
    return Math.min(100, Math.max(0, Math.round(userData.PlayedPercentage)));
  }
  const position = userData?.PlaybackPositionTicks;
  const runtime = userData?.RunTimeTicks ?? item.RunTimeTicks;
  if (!position || !runtime) {
    return undefined;
  }
  const pct = Math.round((position / runtime) * 100);
  return Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : undefined;
};

export const mapJellyfinItemsToLibraryTitles = async (
  items: JellyfinLibraryItemExtended[]
): Promise<LibraryTitle[]> => {
  const mediaByItemId = await resolveMediaRows(items);
  return items.map((item) => {
    const media = mediaByItemId.get(item.Id);
    const tmdbId = media?.tmdbId ?? tmdbIdFromProviders(item);
    const mediaType =
      media?.mediaType === MediaType.MOVIE
        ? 'movie'
        : media?.mediaType === MediaType.TV
          ? 'tv'
          : mediaTypeFromItem(item);

    const jellyfinSeriesId =
      item.Type === 'Series'
        ? item.Id
        : item.Type === 'Episode'
          ? item.SeriesId
          : undefined;

    const playItemId =
      item.Type === 'Movie' || item.Type === 'Episode' ? item.Id : undefined;

    return {
      mediaId: media?.id,
      tmdbId,
      mediaType,
      jellyfinItemId: item.Id,
      playItemId,
      jellyfinSeriesId,
      title: titleForItem(item),
      subtitle: subtitleForItem(item),
      overview: item.Overview,
      mediaUrl: media?.mediaUrl ?? mediaUrlForItem(item.Id),
      status: media?.status,
      progressPercent: progressFromItem(item),
      startPositionTicks: item.UserData?.PlaybackPositionTicks,
      ...libraryTitleDisplayFields(item),
    };
  });
};

const applyPlayTarget = (
  title: LibraryTitle,
  target: ReturnType<typeof resolveSeriesPlayTarget>
): LibraryTitle => {
  if (!target) return title;
  return {
    ...title,
    playItemId: target.playItemId,
    subtitle: title.subtitle ?? target.subtitle,
    progressPercent: title.progressPercent ?? target.progressPercent,
    startPositionTicks: title.startPositionTicks ?? target.startPositionTicks,
  };
};

const nextUpBySeriesId = (
  nextUp: JellyfinLibraryItemExtended[]
): Map<string, JellyfinLibraryItemExtended> => {
  const map = new Map<string, JellyfinLibraryItemExtended>();
  for (const item of nextUp) {
    if (item.Type === 'Episode' && item.SeriesId && !map.has(item.SeriesId)) {
      map.set(item.SeriesId, item);
    }
  }
  return map;
};

const resumeBySeriesId = (
  resume: JellyfinLibraryItemExtended[]
): Map<string, JellyfinLibraryItemExtended> => {
  const map = new Map<string, JellyfinLibraryItemExtended>();
  for (const item of resume) {
    if (
      item.Type === 'Episode' &&
      item.SeriesId &&
      !map.has(item.SeriesId) &&
      ((item.UserData?.PlaybackPositionTicks ?? 0) > 0 ||
        ((item.UserData?.PlayedPercentage ?? 0) > 0 &&
          (item.UserData?.PlayedPercentage ?? 0) < 95))
    ) {
      map.set(item.SeriesId, item);
    }
  }
  return map;
};

const fetchAllSeriesEpisodes = async (
  client: JellyfinAPI,
  seriesId: string
): Promise<JellyfinLibraryItemExtended[]> => client.getSeriesEpisodes(seriesId);

/** Attach playItemId for series rows using resume/next-up, then optional full resolve. */
export const enrichSeriesPlayTargets = async (
  client: JellyfinAPI,
  titles: LibraryTitle[],
  options: {
    resume?: JellyfinLibraryItemExtended[];
    nextUp?: JellyfinLibraryItemExtended[];
    resolveMissing?: boolean;
  } = {}
): Promise<LibraryTitle[]> => {
  const resume =
    options.resume ??
    (await client
      .getResumeItems(32)
      .catch(() => [] as JellyfinLibraryItemExtended[]));
  const nextUp =
    options.nextUp ??
    (await client
      .getNextUpEpisodes(48)
      .catch(() => [] as JellyfinLibraryItemExtended[]));

  const resumeMap = resumeBySeriesId(resume);
  const nextUpMap = nextUpBySeriesId(nextUp);

  const withQuickTarget = titles.map((title) => {
    if (title.mediaType !== 'tv' || title.playItemId) {
      return title;
    }

    const seriesId = title.jellyfinSeriesId ?? title.jellyfinItemId;
    const resumeHit = resumeMap.get(seriesId);
    if (resumeHit) {
      return applyPlayTarget(
        { ...title, jellyfinSeriesId: seriesId },
        resolveSeriesPlayTarget(seriesId, [resumeHit], [resumeHit])
      );
    }

    const nextHit = nextUpMap.get(seriesId);
    if (nextHit) {
      return applyPlayTarget(
        { ...title, jellyfinSeriesId: seriesId },
        {
          playItemId: nextHit.Id,
          subtitle: `Up next ${
            nextHit.ParentIndexNumber != null && nextHit.IndexNumber != null
              ? `S${nextHit.ParentIndexNumber}E${nextHit.IndexNumber}`
              : nextHit.Name || 'Episode'
          }`,
          progressPercent: progressFromItem(nextHit),
          startPositionTicks: nextHit.UserData?.PlaybackPositionTicks,
        }
      );
    }

    return { ...title, jellyfinSeriesId: seriesId };
  });

  if (!options.resolveMissing) {
    return withQuickTarget;
  }

  const missing = withQuickTarget
    .map((title, index) => ({ title, index }))
    .filter(({ title }) => title.mediaType === 'tv' && !title.playItemId);

  const resolved = await mapLimit(
    missing,
    PLAY_TARGET_CONCURRENCY,
    async ({ title }) => {
      const seriesId = title.jellyfinSeriesId ?? title.jellyfinItemId;
      try {
        const episodes = await fetchAllSeriesEpisodes(client, seriesId);
        const target = resolveSeriesPlayTarget(
          seriesId,
          episodes,
          resume.filter((e) => e.SeriesId === seriesId)
        );
        return applyPlayTarget(
          { ...title, jellyfinSeriesId: seriesId },
          target
        );
      } catch (e) {
        logger.debug('Failed to resolve series play target', {
          label: 'Library',
          seriesId,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
        return { ...title, jellyfinSeriesId: seriesId };
      }
    }
  );

  const enriched = [...withQuickTarget];
  resolved.forEach((title, index) => {
    enriched[missing[index].index] = title;
  });
  return enriched;
};

export const buildForgottenRequestsShelf = async (
  userId: number,
  limit = 20
): Promise<LibraryTitle[]> => {
  const requestRepository = getRepository(MediaRequest);
  const requests = await requestRepository
    .createQueryBuilder('request')
    .leftJoinAndSelect('request.media', 'media')
    .leftJoinAndSelect('request.requestedBy', 'requestedBy')
    .where('requestedBy.id = :userId', { userId })
    .andWhere('request.status IN (:...statuses)', {
      statuses: [MediaRequestStatus.APPROVED, MediaRequestStatus.COMPLETED],
    })
    .andWhere('media.status IN (:...mediaStatuses)', {
      mediaStatuses: [MediaStatus.AVAILABLE, MediaStatus.PARTIALLY_AVAILABLE],
    })
    .andWhere(
      '(media.jellyfinMediaId IS NOT NULL OR media.jellyfinMediaId4k IS NOT NULL)'
    )
    .orderBy('request.updatedAt', 'DESC')
    .take(limit * 2)
    .getMany();

  const titles: LibraryTitle[] = [];
  const seen = new Set<number>();
  for (const request of requests) {
    const media = request.media;
    if (!media || seen.has(media.id)) continue;
    seen.add(media.id);
    const jellyfinItemId =
      (!request.is4k ? media.jellyfinMediaId : media.jellyfinMediaId4k) ??
      media.jellyfinMediaId ??
      media.jellyfinMediaId4k;
    if (!jellyfinItemId) continue;
    titles.push({
      mediaId: media.id,
      tmdbId: media.tmdbId,
      mediaType: media.mediaType === MediaType.MOVIE ? 'movie' : 'tv',
      jellyfinItemId,
      jellyfinSeriesId:
        media.mediaType === MediaType.TV ? jellyfinItemId : undefined,
      title: media.mediaType === MediaType.MOVIE ? 'Movie' : 'Series',
      mediaUrl: request.is4k ? media.mediaUrl4k : media.mediaUrl,
      status: media.status,
      posterUrl: libraryItemImageUrl(jellyfinItemId, 'primary'),
      backdropUrl: libraryItemImageUrl(jellyfinItemId, 'backdrop'),
    });
    if (titles.length >= limit) break;
  }

  return titles;
};

export const hydrateForgottenLibraryTitles = (
  forgotten: LibraryTitle[],
  jellyfinItems: {
    Id: string;
    Type?: string;
    Name?: string;
    SeriesName?: string;
    SeriesId?: string;
    ParentIndexNumber?: number;
    IndexNumber?: number;
    Overview?: string;
    ProductionYear?: number;
    Genres?: string[];
    DateCreated?: string;
    RunTimeTicks?: number;
    BackdropImageTags?: string[];
    UserData?: {
      Played?: boolean;
      PlayedPercentage?: number;
      PlaybackPositionTicks?: number;
      LastPlayedDate?: string;
      RunTimeTicks?: number;
      UnplayedItemCount?: number;
    };
  }[]
): LibraryTitle[] => {
  const byId = new Map(jellyfinItems.map((item) => [item.Id, item]));
  return forgotten.map((title) => {
    const item = byId.get(title.jellyfinItemId);
    if (!item) {
      return {
        ...title,
        posterUrl:
          title.posterUrl ??
          libraryItemImageUrl(title.jellyfinItemId, 'primary'),
        backdropUrl:
          title.backdropUrl ??
          libraryItemImageUrl(title.jellyfinItemId, 'backdrop'),
      };
    }
    return {
      ...title,
      title: titleForItem(item as JellyfinLibraryItemExtended),
      subtitle: subtitleForItem(item as JellyfinLibraryItemExtended),
      overview: item.Overview ?? title.overview,
      ...libraryTitleDisplayFields(item),
    };
  });
};

interface WatchNowSources {
  resume: JellyfinLibraryItemExtended[];
  latest: JellyfinLibraryItemExtended[];
  nextUp: JellyfinLibraryItemExtended[];
  latestEpisodes: JellyfinLibraryItemExtended[];
  failed: boolean;
}

interface WatchNowShelfResult {
  shelf?: LibraryShelf;
  failed: boolean;
}

const loadWatchNowSources = async (
  client: JellyfinAPI,
  tvLibraryIds: string[]
): Promise<WatchNowSources> => {
  const results = await Promise.allSettled([
    client.getResumeItems(16),
    client.getUserLatestItems(16),
    client.getNextUpEpisodes(48),
    ...(tvLibraryIds.length
      ? tvLibraryIds.map((id) => client.getUserLatestEpisodes(32, id))
      : [client.getUserLatestEpisodes(32)]),
  ]);
  const failed = results.some((result) => result.status === 'rejected');
  if (failed) {
    logger.error('Failed to load some Jellyfin watch-now sources', {
      label: 'Library',
      errorMessage: results
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected'
        )
        .map((result) =>
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason)
        )
        .join('; '),
    });
  }

  const latestEpisodeBySeries = new Map<string, JellyfinLibraryItemExtended>();
  results.slice(3).forEach((result) => {
    if (result.status !== 'fulfilled') return;
    result.value.forEach((item) => {
      const key = item.SeriesId ?? item.Id;
      if (!latestEpisodeBySeries.has(key)) latestEpisodeBySeries.set(key, item);
    });
  });

  return {
    resume: settledValue(results[0], []),
    latest: settledValue(results[1], []),
    nextUp: settledValue(results[2], []),
    latestEpisodes: [...latestEpisodeBySeries.values()]
      .sort((a, b) => {
        const da = a.DateCreated ? Date.parse(a.DateCreated) : 0;
        const db = b.DateCreated ? Date.parse(b.DateCreated) : 0;
        return db - da;
      })
      .slice(0, 16),
    failed,
  };
};

const buildContinueWatchingShelf = async (
  resume: JellyfinLibraryItemExtended[]
): Promise<WatchNowShelfResult> => {
  try {
    const items = await mapJellyfinItemsToLibraryTitles(resume);
    return {
      shelf: items.length
        ? { id: 'continue', title: 'Continue Watching', items }
        : undefined,
      failed: false,
    };
  } catch (e) {
    logger.error('Failed to map Continue Watching shelf', {
      label: 'Library',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return { failed: true };
  }
};

const buildRecentlyAddedShelf = async (
  client: JellyfinAPI,
  latest: JellyfinLibraryItemExtended[],
  resume: JellyfinLibraryItemExtended[],
  nextUp: JellyfinLibraryItemExtended[]
): Promise<WatchNowShelfResult> => {
  try {
    const items = filterPlayableLibraryTitles(
      await enrichSeriesPlayTargets(
        client,
        await mapJellyfinItemsToLibraryTitles(latest),
        { resume, nextUp, resolveMissing: true }
      )
    );
    return {
      shelf: items.length
        ? { id: 'recent', title: 'Recently Added', items }
        : undefined,
      failed: false,
    };
  } catch (e) {
    logger.error('Failed to map Recently Added shelf', {
      label: 'Library',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return { failed: true };
  }
};

const buildRecentlyAddedEpisodesShelf = async (
  client: JellyfinAPI,
  latestEpisodes: JellyfinLibraryItemExtended[]
): Promise<WatchNowShelfResult> => {
  try {
    const items = await mapJellyfinItemsToLibraryTitles(latestEpisodes);
    const missingTmdb = items.filter(
      (item) => !item.tmdbId && item.jellyfinSeriesId
    );
    if (missingTmdb.length) {
      const seriesIds = [
        ...new Set(missingTmdb.map((item) => item.jellyfinSeriesId!)),
      ];
      const seriesItems = await Promise.allSettled(
        seriesIds.map((id) => client.getItemData(id))
      );
      const tmdbBySeriesId = new Map<string, number>();
      seriesItems.forEach((result, index) => {
        if (result.status !== 'fulfilled' || !result.value) return;
        const raw =
          result.value.ProviderIds?.Tmdb ??
          result.value.ProviderIds?.TheMovieDb;
        const tmdbId = raw ? Number(raw) : NaN;
        if (Number.isFinite(tmdbId) && tmdbId > 0) {
          tmdbBySeriesId.set(seriesIds[index], tmdbId);
        }
      });
      items.forEach((item) => {
        if (!item.tmdbId && item.jellyfinSeriesId) {
          const tmdbId = tmdbBySeriesId.get(item.jellyfinSeriesId);
          if (tmdbId) item.tmdbId = tmdbId;
        }
      });
    }
    return {
      shelf: items.length
        ? {
            id: 'recent-episodes',
            title: 'Recently Added Episodes',
            items,
          }
        : undefined,
      failed: false,
    };
  } catch (e) {
    logger.error('Failed to map Recently Added Episodes shelf', {
      label: 'Library',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return { failed: true };
  }
};

const buildForgottenShelf = async (
  userId: number,
  client: JellyfinAPI,
  resume: JellyfinLibraryItemExtended[],
  nextUp: JellyfinLibraryItemExtended[]
): Promise<WatchNowShelfResult> => {
  try {
    const forgottenBase = filterPlayableLibraryTitles(
      await enrichSeriesPlayTargets(
        client,
        await buildForgottenRequestsShelf(userId, 16),
        { resume, nextUp, resolveMissing: true }
      )
    );
    let forgottenItems: JellyfinLibraryItemExtended[] = [];
    try {
      forgottenItems = await client.getItemsData(
        forgottenBase.map((title) => title.jellyfinItemId)
      );
    } catch (e) {
      logger.debug('Failed to hydrate Ready to Watch items from Jellyfin', {
        label: 'Library',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
    const items = hydrateForgottenLibraryTitles(forgottenBase, forgottenItems);
    return {
      shelf: items.length
        ? { id: 'forgotten', title: 'Ready to Watch', items }
        : undefined,
      failed: false,
    };
  } catch (e) {
    logger.error('Failed to load Ready to Watch shelf', {
      label: 'Library',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return { failed: true };
  }
};

export const buildWatchNowResponse = async (
  userId: number
): Promise<LibraryWatchNowResponse> => {
  const linked = await createUserJellyfinClient(userId);
  if (!linked.ok) {
    return { shelves: [], code: linked.code };
  }

  const settings = getSettings();
  const tvLibraryIds = (settings.jellyfin.libraries ?? [])
    .filter((lib) => lib.enabled && lib.type === 'show')
    .map((lib) => lib.id)
    .filter(Boolean);

  const sources = await loadWatchNowSources(linked.client, tvLibraryIds);
  const { resume, latest, nextUp, latestEpisodes } = sources;
  const shelves: LibraryShelf[] = [];

  const shelfResults = await Promise.all([
    buildContinueWatchingShelf(resume),
    buildRecentlyAddedShelf(linked.client, latest, resume, nextUp),
    buildRecentlyAddedEpisodesShelf(linked.client, latestEpisodes),
    buildForgottenShelf(userId, linked.client, resume, nextUp),
  ]);
  shelves.push(
    ...shelfResults.flatMap((result) => (result.shelf ? [result.shelf] : []))
  );

  if (
    !shelves.length &&
    (sources.failed || shelfResults.some((r) => r.failed))
  ) {
    return { shelves: [], code: 'server_unreachable' };
  }

  return { shelves };
};

export const listAvailableLibrary = async (options: {
  take: number;
  skip: number;
  mediaType?: 'movie' | 'tv';
  query?: string;
  userId: number;
}): Promise<{
  results: LibraryTitle[];
  total: number;
  code?: LibraryWatchNowResponse['code'];
}> => {
  const query = options.query?.trim();

  // Title search via user-linked Jellyfin when q is present.
  if (query && !/^\d+$/.test(query)) {
    const linked = await createUserJellyfinClient(options.userId);
    if (!linked.ok) {
      return { results: [], total: 0, code: linked.code };
    }
    try {
      const items = await linked.client.searchLibraryItems(query, {
        limit: options.take,
        startIndex: options.skip,
        mediaType: options.mediaType,
      });
      const mapped = filterPlayableLibraryTitles(
        await enrichSeriesPlayTargets(
          linked.client,
          await mapJellyfinItemsToLibraryTitles(items),
          { resolveMissing: true }
        )
      );
      // Keep only items we know are in Foreseer available catalog when possible;
      // still return Jellyfin hits that map so play works.
      return { results: mapped, total: mapped.length };
    } catch (e) {
      logger.error('Failed to search Jellyfin library', {
        label: 'Library',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      return { results: [], total: 0, code: 'server_unreachable' };
    }
  }

  const mediaRepository = getRepository(Media);
  const qb = mediaRepository
    .createQueryBuilder('media')
    .where('media.status IN (:...statuses)', {
      statuses: [MediaStatus.AVAILABLE, MediaStatus.PARTIALLY_AVAILABLE],
    })
    .andWhere(
      '(media.jellyfinMediaId IS NOT NULL OR media.jellyfinMediaId4k IS NOT NULL)'
    )
    .orderBy('media.mediaAddedAt', 'DESC', 'NULLS LAST')
    .addOrderBy('media.updatedAt', 'DESC');

  if (options.mediaType) {
    qb.andWhere('media.mediaType = :mediaType', {
      mediaType: options.mediaType,
    });
  }

  if (query && /^\d+$/.test(query)) {
    qb.andWhere('media.tmdbId = :tmdbId', { tmdbId: Number(query) });
  }

  const total = await qb.getCount();
  const media = await qb.skip(options.skip).take(options.take).getMany();

  const results: LibraryTitle[] = media.map((m) => {
    const jellyfinItemId = m.jellyfinMediaId ?? m.jellyfinMediaId4k ?? '';
    return {
      mediaId: m.id,
      tmdbId: m.tmdbId,
      mediaType: m.mediaType === MediaType.MOVIE ? 'movie' : 'tv',
      jellyfinItemId,
      jellyfinSeriesId:
        m.mediaType === MediaType.TV ? jellyfinItemId : undefined,
      title: m.mediaType === MediaType.MOVIE ? 'Movie' : 'Series',
      mediaUrl: m.mediaUrl ?? m.mediaUrl4k,
      status: m.status,
    };
  });

  const linked = await createUserJellyfinClient(options.userId);
  if (linked.ok) {
    try {
      const enriched = filterPlayableLibraryTitles(
        await enrichSeriesPlayTargets(linked.client, results, {
          resolveMissing: true,
        })
      );
      return { results: enriched, total };
    } catch (e) {
      logger.debug('Failed to enrich available library play targets', {
        label: 'Library',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { results, total };
};

export const listBrowseLibrary = async (
  userId: number,
  query: ParsedLibraryBrowseQuery
): Promise<{
  results: LibraryTitle[];
  total: number;
  code?: LibraryBrowseResponse['code'];
}> => {
  const linked = await createUserJellyfinClient(userId);
  if (!linked.ok) {
    return { results: [], total: 0, code: linked.code };
  }

  try {
    return await listBrowseFromClient(
      linked.client,
      linked.user.jellyfinUserId ?? 'Me',
      query,
      mapJellyfinItemsToLibraryTitles
    );
  } catch (e) {
    logger.error('Failed to browse Jellyfin library', {
      label: 'Library',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return { results: [], total: 0, code: 'server_unreachable' };
  }
};

export const getLibraryFacetsForUser = async (
  userId: number,
  mediaType?: 'movie' | 'tv'
): Promise<LibraryFacetsResponse> => {
  const linked = await createUserJellyfinClient(userId);
  if (!linked.ok) {
    return { genres: [], code: linked.code };
  }

  try {
    return await linked.client.getLibraryFacets(mediaType);
  } catch (e) {
    logger.error('Failed to load library facets', {
      label: 'Library',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return { genres: [], code: 'server_unreachable' };
  }
};

export const resolveInspectorTargetId = (
  item: Pick<JellyfinLibraryItemExtended, 'Id' | 'Type' | 'SeriesId'>
): string =>
  item.Type === 'Episode' && item.SeriesId ? item.SeriesId : item.Id;

export const toInspectorResponse = (
  title: LibraryTitle,
  extras: {
    seasons?: LibrarySeriesSeason[];
    playUrl?: string;
    playItemId?: string;
    subtitle?: string;
    startPositionTicks?: number;
    code?: LibraryItemInspectorResponse['code'];
  } = {}
): LibraryItemInspectorResponse => ({
  jellyfinItemId: title.jellyfinItemId,
  jellyfinSeriesId: title.jellyfinSeriesId,
  mediaType: title.mediaType,
  title: title.title,
  subtitle: extras.subtitle ?? title.subtitle,
  overview: title.overview,
  year: title.year,
  runtimeMinutes: title.runtimeMinutes,
  genres: title.genres,
  posterUrl: title.posterUrl,
  backdropUrl: title.backdropUrl,
  progressPercent: title.progressPercent,
  watched: title.watched,
  inProgress: title.inProgress,
  startPositionTicks: extras.startPositionTicks ?? title.startPositionTicks,
  playItemId: extras.playItemId ?? title.playItemId,
  playUrl: extras.playUrl,
  mediaUrl: title.mediaUrl,
  mediaId: title.mediaId,
  tmdbId: title.tmdbId,
  status: title.status,
  seasons: extras.seasons,
  code: extras.code,
});

export const getLibraryItemInspector = async (
  userId: number,
  jellyfinItemId: string
): Promise<LibraryItemInspectorResponse> => {
  const linked = await createUserJellyfinClient(userId);
  if (!linked.ok) {
    return {
      jellyfinItemId,
      mediaType: 'movie',
      title: 'Title',
      code: linked.code,
    };
  }

  try {
    const item = await linked.client.getItemData(jellyfinItemId);
    if (!item) {
      return {
        jellyfinItemId,
        mediaType: 'movie',
        title: 'Title',
        code: 'not_found',
      };
    }

    const targetId = resolveInspectorTargetId(item);
    const target =
      targetId === item.Id ? item : await linked.client.getItemData(targetId);
    if (!target) {
      return {
        jellyfinItemId: targetId,
        mediaType: 'tv',
        title: 'Series',
        code: 'not_found',
      };
    }

    if (target.Type === 'Series') {
      const [mapped, series] = await Promise.all([
        mapJellyfinItemsToLibraryTitles([target]),
        getLibrarySeriesDetail(userId, target.Id),
      ]);
      return toInspectorResponse(mapped[0], {
        seasons: series.seasons,
        playItemId: series.playItemId,
        playUrl: series.playUrl,
        subtitle: series.subtitle,
        startPositionTicks: series.startPositionTicks,
        code: series.code,
      });
    }

    const mapped = await mapJellyfinItemsToLibraryTitles([target]);
    const title = mapped[0];
    return toInspectorResponse(title, {
      playUrl: title.playItemId ? mediaUrlForItem(title.playItemId) : undefined,
    });
  } catch (e) {
    logger.error('Failed to load library inspector', {
      label: 'Library',
      jellyfinItemId,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return {
      jellyfinItemId,
      mediaType: 'movie',
      title: 'Title',
      code: 'server_unreachable',
    };
  }
};

export const getLibraryItemImage = async (
  userId: number,
  jellyfinItemId: string,
  imageType: 'primary' | 'backdrop'
): Promise<
  | { ok: true; buffer: Buffer; contentType: string }
  | {
      ok: false;
      status: number;
      code?: 'not_linked' | 'unsupported_media_server' | 'not_found';
    }
> => {
  const cached = getCachedLibraryImage(userId, jellyfinItemId, imageType);
  if (cached) {
    return { ok: true, ...cached };
  }

  const linked = await createUserJellyfinClient(userId);
  if (!linked.ok) {
    return { ok: false, status: 401, code: linked.code };
  }

  try {
    const image = await linked.client.getItemImage(jellyfinItemId, imageType);
    if (!image) {
      return { ok: false, status: 404, code: 'not_found' };
    }
    setCachedLibraryImage(userId, jellyfinItemId, imageType, image);
    return { ok: true, ...image };
  } catch (e) {
    logger.error('Failed to proxy library image', {
      label: 'Library',
      jellyfinItemId,
      imageType,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, status: 502 };
  }
};

export const getLibrarySeriesDetail = async (
  userId: number,
  jellyfinSeriesId: string
): Promise<LibrarySeriesDetailResponse> => {
  const linked = await createUserJellyfinClient(userId);
  if (!linked.ok) {
    return {
      jellyfinSeriesId,
      title: 'Series',
      seasons: [],
      code: linked.code,
    };
  }

  try {
    const [seasonsRaw, nextUp, resume, seriesItem] = await Promise.all([
      linked.client.getSeasons(jellyfinSeriesId),
      linked.client.getNextUpEpisodes(8, jellyfinSeriesId),
      linked.client.getResumeItems(32),
      linked.client.getItemData(jellyfinSeriesId),
    ]);

    const seasons: LibrarySeriesSeason[] = (seasonsRaw ?? [])
      .filter((season) => Boolean(season?.Id))
      .map((season) => ({
        jellyfinSeasonId: season.Id,
        name: season.Name || `Season ${season.IndexNumber ?? ''}`,
        indexNumber: season.IndexNumber,
      }));

    const seriesTitle = seriesItem?.Name;

    let playTarget: SeriesPlayTarget | undefined = nextUp[0]
      ? {
          playItemId: nextUp[0].Id,
          subtitle: `Up next ${
            nextUp[0].ParentIndexNumber != null && nextUp[0].IndexNumber != null
              ? `S${nextUp[0].ParentIndexNumber}E${nextUp[0].IndexNumber}`
              : nextUp[0].Name || 'Episode'
          }`,
          progressPercent: progressFromItem(nextUp[0]),
          startPositionTicks: nextUp[0].UserData?.PlaybackPositionTicks,
        }
      : undefined;

    // NextUp/resume first; one episode-list request covers completed-series rewatch.
    const resumeHit = resume.find(
      (e) =>
        e.SeriesId === jellyfinSeriesId &&
        e.Type === 'Episode' &&
        ((e.UserData?.PlaybackPositionTicks ?? 0) > 0 ||
          ((e.UserData?.PlayedPercentage ?? 0) > 0 &&
            (e.UserData?.PlayedPercentage ?? 0) < 95))
    );
    if (!playTarget && resumeHit) {
      playTarget = resolveSeriesPlayTarget(
        jellyfinSeriesId,
        [resumeHit],
        [resumeHit]
      );
    }

    if (!playTarget) {
      try {
        const episodes = await fetchAllSeriesEpisodes(
          linked.client,
          jellyfinSeriesId
        );
        playTarget = resolveSeriesPlayTarget(
          jellyfinSeriesId,
          episodes,
          resume.filter((episode) => episode.SeriesId === jellyfinSeriesId)
        );
      } catch (e) {
        logger.debug('Failed to resolve series rewatch target', {
          label: 'Library',
          jellyfinSeriesId,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      }
    }

    const mediaRows = await resolveMediaRows([
      {
        Id: jellyfinSeriesId,
        Name: seriesTitle || 'Series',
        Type: 'Series',
        HasSubtitles: false,
        LocationType: 'FileSystem',
        MediaType: 'Video',
        ProviderIds: {},
      } as JellyfinLibraryItemExtended,
    ]);
    const media = mediaRows.get(jellyfinSeriesId);

    return {
      jellyfinSeriesId,
      tmdbId: media?.tmdbId,
      title: seriesTitle || 'Series',
      playItemId: playTarget?.playItemId,
      playUrl: playTarget ? mediaUrlForItem(playTarget.playItemId) : undefined,
      subtitle: playTarget?.subtitle,
      startPositionTicks: playTarget?.startPositionTicks,
      seasons,
    };
  } catch (e) {
    logger.error('Failed to load library series detail', {
      label: 'Library',
      jellyfinSeriesId,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return {
      jellyfinSeriesId,
      title: 'Series',
      seasons: [],
      code: 'server_unreachable',
    };
  }
};

export const getLibrarySeasonEpisodes = async (
  userId: number,
  jellyfinSeriesId: string,
  seasonId: string
): Promise<LibrarySeasonEpisodesResponse> => {
  const linked = await createUserJellyfinClient(userId);
  if (!linked.ok) {
    return {
      jellyfinSeriesId,
      jellyfinSeasonId: seasonId,
      episodes: [],
      code: linked.code,
    };
  }

  try {
    const items = await linked.client.getEpisodes(jellyfinSeriesId, seasonId);
    const episodes: LibraryEpisode[] = (items ?? []).map((item) => {
      const extended = item as JellyfinLibraryItemExtended;
      const season = extended.ParentIndexNumber;
      const number = extended.IndexNumber;
      return {
        jellyfinItemId: extended.Id,
        name: extended.Name || 'Episode',
        indexNumber: number,
        parentIndexNumber: season,
        subtitle:
          season != null && number != null ? `S${season}E${number}` : undefined,
        overview: extended.Overview,
        mediaUrl: mediaUrlForItem(extended.Id),
        progressPercent: progressFromItem(extended),
        startPositionTicks: extended.UserData?.PlaybackPositionTicks,
        watched: Boolean(
          extended.UserData?.Played ||
          (extended.UserData?.PlayedPercentage ?? 0) >= 95
        ),
      };
    });

    return {
      jellyfinSeriesId,
      jellyfinSeasonId: seasonId,
      episodes,
    };
  } catch (e) {
    logger.error('Failed to load library season episodes', {
      label: 'Library',
      jellyfinSeriesId,
      seasonId,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return {
      jellyfinSeriesId,
      jellyfinSeasonId: seasonId,
      episodes: [],
      code: 'server_unreachable',
    };
  }
};
