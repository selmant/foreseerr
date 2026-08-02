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
  LibraryEpisode,
  LibrarySeasonEpisodesResponse,
  LibrarySeriesDetailResponse,
  LibrarySeriesSeason,
  LibraryShelf,
  LibraryTitle,
  LibraryWatchNowResponse,
} from '@server/interfaces/api/libraryInterfaces';
import type { SeriesPlayTarget } from '@server/lib/libraryPlayTarget';
import { resolveSeriesPlayTarget } from '@server/lib/libraryPlayTarget';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { getHostname } from '@server/utils/getHostname';

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
    user.jellyfinDeviceId
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

const mediaUrlForItem = (jellyfinItemId: string): string | undefined => {
  const settings = getSettings();
  const jellyfin = settings.jellyfin;
  if (!jellyfin.ip && !jellyfin.externalHostname) return undefined;
  const jellyfinHost =
    jellyfin.externalHostname && jellyfin.externalHostname.length > 0
      ? jellyfin.externalHostname
      : getHostname();
  const serverId = jellyfin.serverId ?? '';
  return `${jellyfinHost}/web/index.html#!/details?id=${jellyfinItemId}&context=home&serverId=${serverId}`;
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
): Promise<JellyfinLibraryItemExtended[]> => {
  const seasons = await client.getSeasons(seriesId);
  const episodes: JellyfinLibraryItemExtended[] = [];
  for (const season of seasons ?? []) {
    if (!season?.Id) continue;
    const seasonEpisodes = await client.getEpisodes(seriesId, season.Id);
    for (const episode of seasonEpisodes ?? []) {
      episodes.push(episode as JellyfinLibraryItemExtended);
    }
  }
  return episodes;
};

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

  const enriched: LibraryTitle[] = [];
  for (const title of titles) {
    if (title.mediaType !== 'tv' || title.playItemId) {
      enriched.push(title);
      continue;
    }

    const seriesId = title.jellyfinSeriesId ?? title.jellyfinItemId;
    const resumeHit = resumeMap.get(seriesId);
    if (resumeHit) {
      enriched.push(
        applyPlayTarget(
          { ...title, jellyfinSeriesId: seriesId },
          resolveSeriesPlayTarget(seriesId, [resumeHit], [resumeHit])
        )
      );
      continue;
    }

    const nextHit = nextUpMap.get(seriesId);
    if (nextHit) {
      enriched.push(
        applyPlayTarget(
          { ...title, jellyfinSeriesId: seriesId },
          {
            playItemId: nextHit.Id,
            subtitle: `Up next ${
              nextHit.ParentIndexNumber != null && nextHit.IndexNumber != null
                ? `S${nextHit.ParentIndexNumber}E${nextHit.IndexNumber}`
                : nextHit.Name || 'Episode'
            }`,
            progressPercent: progressFromItem(nextHit),
          }
        )
      );
      continue;
    }

    if (!options.resolveMissing) {
      enriched.push({ ...title, jellyfinSeriesId: seriesId });
      continue;
    }

    try {
      const episodes = await fetchAllSeriesEpisodes(client, seriesId);
      const target = resolveSeriesPlayTarget(
        seriesId,
        episodes,
        resume.filter((e) => e.SeriesId === seriesId)
      );
      enriched.push(
        applyPlayTarget({ ...title, jellyfinSeriesId: seriesId }, target)
      );
    } catch (e) {
      logger.debug('Failed to resolve series play target', {
        label: 'Library',
        seriesId,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      enriched.push({ ...title, jellyfinSeriesId: seriesId });
    }
  }

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
      title:
        media.mediaType === MediaType.MOVIE
          ? `Movie ${media.tmdbId}`
          : `Series ${media.tmdbId}`,
      mediaUrl: request.is4k ? media.mediaUrl4k : media.mediaUrl,
      status: media.status,
    });
    if (titles.length >= limit) break;
  }

  return titles;
};

export const buildWatchNowResponse = async (
  userId: number
): Promise<LibraryWatchNowResponse> => {
  const linked = await createUserJellyfinClient(userId);
  if (!linked.ok) {
    return { shelves: [], code: linked.code };
  }

  const shelves: LibraryShelf[] = [];

  try {
    const settings = getSettings();
    const tvLibraryIds = (settings.jellyfin.libraries ?? [])
      .filter((lib) => lib.enabled && lib.type === 'show')
      .map((lib) => lib.id)
      .filter(Boolean);

    const [resume, latest, nextUp, ...latestEpisodeBatches] = await Promise.all(
      [
        linked.client.getResumeItems(16),
        linked.client.getUserLatestItems(16),
        linked.client.getNextUpEpisodes(48),
        ...(tvLibraryIds.length
          ? tvLibraryIds.map((id) =>
              linked.client.getUserLatestEpisodes(16, id)
            )
          : [linked.client.getUserLatestEpisodes(16)]),
      ]
    );

    const latestEpisodeById = new Map<string, JellyfinLibraryItemExtended>();
    for (const batch of latestEpisodeBatches) {
      for (const item of batch) {
        if (!latestEpisodeById.has(item.Id)) {
          latestEpisodeById.set(item.Id, item);
        }
      }
    }
    const latestEpisodes = [...latestEpisodeById.values()]
      .sort((a, b) => {
        const da = a.DateCreated ? Date.parse(a.DateCreated) : 0;
        const db = b.DateCreated ? Date.parse(b.DateCreated) : 0;
        return db - da;
      })
      .slice(0, 16);

    const continueItems = await mapJellyfinItemsToLibraryTitles(resume);
    if (continueItems.length) {
      shelves.push({
        id: 'continue',
        title: 'Continue Watching',
        items: continueItems,
      });
    }

    const recentItems = await enrichSeriesPlayTargets(
      linked.client,
      await mapJellyfinItemsToLibraryTitles(latest),
      { resume, nextUp, resolveMissing: true }
    );
    if (recentItems.length) {
      shelves.push({
        id: 'recent',
        title: 'Recently Added',
        items: recentItems,
      });
    }

    const recentEpisodeItems =
      await mapJellyfinItemsToLibraryTitles(latestEpisodes);
    if (recentEpisodeItems.length) {
      shelves.push({
        id: 'recent-episodes',
        title: 'Recently Added Episodes',
        items: recentEpisodeItems,
      });
    }
  } catch (e) {
    logger.error('Failed to load Jellyfin watch-now shelves', {
      label: 'Library',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return { shelves: [], code: 'server_unreachable' };
  }

  const forgotten = await enrichSeriesPlayTargets(
    linked.client,
    await buildForgottenRequestsShelf(userId, 16),
    { resolveMissing: true }
  );
  if (forgotten.length) {
    shelves.push({
      id: 'forgotten',
      title: 'Ready to Watch',
      items: forgotten,
    });
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
        mediaType: options.mediaType,
      });
      const mapped = await enrichSeriesPlayTargets(
        linked.client,
        await mapJellyfinItemsToLibraryTitles(items),
        { resolveMissing: true }
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
      title:
        m.mediaType === MediaType.MOVIE
          ? `Movie ${m.tmdbId}`
          : `Series ${m.tmdbId}`,
      mediaUrl: m.mediaUrl ?? m.mediaUrl4k,
      status: m.status,
    };
  });

  const linked = await createUserJellyfinClient(options.userId);
  if (linked.ok) {
    try {
      const enriched = await enrichSeriesPlayTargets(linked.client, results, {
        resolveMissing: true,
      });
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
    const [seasonsRaw, nextUp, resume] = await Promise.all([
      linked.client.getSeasons(jellyfinSeriesId),
      linked.client.getNextUpEpisodes(8, jellyfinSeriesId),
      linked.client.getResumeItems(32),
    ]);

    const seasons: LibrarySeriesSeason[] = (seasonsRaw ?? [])
      .filter((season) => Boolean(season?.Id))
      .map((season) => ({
        jellyfinSeasonId: season.Id,
        name: season.Name || `Season ${season.IndexNumber ?? ''}`,
        indexNumber: season.IndexNumber,
      }));

    let playTarget: SeriesPlayTarget | undefined = nextUp[0]
      ? {
          playItemId: nextUp[0].Id,
          subtitle: `Up next ${
            nextUp[0].ParentIndexNumber != null && nextUp[0].IndexNumber != null
              ? `S${nextUp[0].ParentIndexNumber}E${nextUp[0].IndexNumber}`
              : nextUp[0].Name || 'Episode'
          }`,
          progressPercent: progressFromItem(nextUp[0]),
        }
      : undefined;

    let seriesTitle =
      nextUp[0]?.SeriesName ||
      resume.find((e) => e.SeriesId === jellyfinSeriesId)?.SeriesName;

    if (!playTarget && seasons.length) {
      const episodes = await fetchAllSeriesEpisodes(
        linked.client,
        jellyfinSeriesId
      );
      playTarget = resolveSeriesPlayTarget(
        jellyfinSeriesId,
        episodes,
        resume.filter((e) => e.SeriesId === jellyfinSeriesId)
      );
      seriesTitle = seriesTitle || episodes[0]?.SeriesName;
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
      title: seriesTitle || `Series ${media?.tmdbId ?? jellyfinSeriesId}`,
      playItemId: playTarget?.playItemId,
      subtitle: playTarget?.subtitle,
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
        progressPercent: progressFromItem(extended),
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
