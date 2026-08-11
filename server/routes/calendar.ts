import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import ReleaseDateChange from '@server/entity/ReleaseDateChange';
import ReleaseOccurrence from '@server/entity/ReleaseOccurrence';
import { Permission } from '@server/lib/permissions';
import { getReleaseRelevanceMap } from '@server/lib/releases/relevance';
import releaseCalendarSync from '@server/lib/releases/sync';
import { getSettings } from '@server/lib/settings';
import { Router } from 'express';
import { In } from 'typeorm';

const MAX_RANGE_DAYS = 366;
const calendarRoutes = Router();

type CalendarScope = 'mine' | 'all';

const readSingle = (value: unknown) =>
  typeof value === 'string' ? value : undefined;

const parseRange = (query: Record<string, unknown>) => {
  const startValue = readSingle(query.start);
  const endValue = readSingle(query.end);
  if (!startValue || !endValue) {
    throw new Error('start and end are required ISO dates or timestamps.');
  }
  const start = new Date(startValue);
  const end = new Date(endValue);
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    end <= start
  ) {
    throw new Error('start and end must define a valid, non-empty range.');
  }
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * 86400000) {
    throw new Error(`Calendar range cannot exceed ${MAX_RANGE_DAYS} days.`);
  }
  return { start, end };
};

export const selectPrimaryRadarrDates = (
  items: ReleaseOccurrence[],
  preference: 'digital' | 'physical' | 'theatrical' = 'digital'
) => {
  const fallbackDates = ['digital', 'physical', 'theatrical'];
  const preferredByMovie = new Map<string, ReleaseOccurrence>();
  for (const item of items) {
    if (item.source !== 'radarr') continue;
    const key = `${item.sourceServerId}:${item.sourceItemId}`;
    const current = preferredByMovie.get(key);
    if (
      !current ||
      [
        preference,
        ...fallbackDates.filter((dateType) => dateType !== preference),
      ].indexOf(item.dateType) <
        [
          preference,
          ...fallbackDates.filter((dateType) => dateType !== preference),
        ].indexOf(current.dateType)
    ) {
      preferredByMovie.set(key, item);
    }
  }
  return items.filter(
    (item) =>
      item.source !== 'radarr' ||
      preferredByMovie.get(`${item.sourceServerId}:${item.sourceItemId}`)
        ?.id === item.id
  );
};

const parseBoolean = (value: unknown) =>
  value === 'true' ? true : value === 'false' ? false : undefined;

calendarRoutes.get('/', async (req, res, next) => {
  let start: Date;
  let end: Date;
  try {
    ({ start, end } = parseRange(req.query));
  } catch (error) {
    return next({
      status: 400,
      message:
        error instanceof Error ? error.message : 'Invalid calendar query.',
    });
  }
  const scope = (readSingle(req.query.scope) ?? 'mine') as CalendarScope;
  const mediaType = readSingle(req.query.mediaType);
  const source = readSingle(req.query.source);
  const serverId = readSingle(req.query.serverId);
  const is4k = parseBoolean(readSingle(req.query.is4k));
  const includeEpisodes =
    parseBoolean(readSingle(req.query.includeEpisodes)) ?? true;
  const includeUnmonitored =
    parseBoolean(readSingle(req.query.includeUnmonitored)) ?? false;
  const isAdmin = req.user?.hasPermission(Permission.ADMIN) ?? false;

  if (scope !== 'mine' && scope !== 'all') {
    return next({ status: 400, message: 'scope must be mine or all.' });
  }
  if (mediaType && mediaType !== 'movie' && mediaType !== 'tv') {
    return next({ status: 400, message: 'mediaType must be movie or tv.' });
  }
  if (source && source !== 'sonarr' && source !== 'radarr') {
    return next({ status: 400, message: 'source must be sonarr or radarr.' });
  }
  if ((!isAdmin && serverId) || (!isAdmin && includeUnmonitored)) {
    return next({
      status: 403,
      message: 'This calendar filter requires administrator permission.',
    });
  }
  if (serverId && (!/^\d+$/.test(serverId) || Number(serverId) < 1)) {
    return next({
      status: 400,
      message: 'serverId must be a positive integer.',
    });
  }

  try {
    const occurrenceRepository = getRepository(ReleaseOccurrence);
    const query = occurrenceRepository
      .createQueryBuilder('occurrence')
      .where('occurrence.startsAt >= :start AND occurrence.startsAt < :end', {
        start,
        end,
      })
      .andWhere('occurrence.missingSince IS NULL');
    if (!includeUnmonitored)
      query.andWhere('occurrence.monitored = :monitored', { monitored: true });
    if (mediaType)
      query.andWhere('occurrence.mediaType = :mediaType', { mediaType });
    if (source) query.andWhere('occurrence.source = :source', { source });
    if (serverId)
      query.andWhere('occurrence.sourceServerId = :serverId', {
        serverId: Number(serverId),
      });
    if (is4k !== undefined) query.andWhere('occurrence.is4k = :is4k', { is4k });
    if (!includeEpisodes) {
      query.andWhere(
        '(occurrence.mediaType = :movie OR occurrence.episodeNumber = 1)',
        {
          movie: 'movie',
        }
      );
    }
    const allOccurrences = await query
      .orderBy('occurrence.startsAt', 'ASC')
      .getMany();
    const movieDates = new Map<
      string,
      { dateType: string; startsAt: string; allDay: boolean }[]
    >();
    for (const occurrence of allOccurrences) {
      if (occurrence.source !== 'radarr') continue;
      const key = `${occurrence.sourceServerId}:${occurrence.sourceItemId}`;
      movieDates.set(key, [
        ...(movieDates.get(key) ?? []),
        {
          dateType: occurrence.dateType,
          startsAt: occurrence.allDay
            ? occurrence.startsAt.toISOString().slice(0, 10)
            : occurrence.startsAt.toISOString(),
          allDay: occurrence.allDay,
        },
      ]);
    }
    const occurrences = selectPrimaryRadarrDates(allOccurrences, 'digital');
    const latestChanges = new Map<number, ReleaseDateChange>();
    if (occurrences.length > 0) {
      const changes = await getRepository(ReleaseDateChange).find({
        where: {
          occurrenceId: In(occurrences.map((occurrence) => occurrence.id)),
        },
        order: { detectedAt: 'DESC' },
      });
      for (const change of changes) {
        if (!latestChanges.has(change.occurrenceId)) {
          latestChanges.set(change.occurrenceId, change);
        }
      }
    }
    const mediaIds = [
      ...new Set(
        occurrences
          .map((occurrence) => occurrence.mediaId)
          .filter((id): id is number => id !== null && id !== undefined)
      ),
    ];
    const mediaById = new Map(
      (mediaIds.length
        ? await getRepository(Media).findBy({ id: In(mediaIds) })
        : []
      ).map((media) => [media.id, media])
    );
    const relevanceByOccurrence = await getReleaseRelevanceMap(occurrences);

    const items = [];
    for (const occurrence of occurrences) {
      const relevance = relevanceByOccurrence.get(occurrence.id) ?? [];
      const currentUserRelevance = relevance.find(
        (item) => item.userId === req.user?.id
      );
      if (scope === 'mine' && !currentUserRelevance) continue;
      const media = occurrence.mediaId
        ? mediaById.get(occurrence.mediaId)
        : undefined;
      const rawWatchUrl = occurrence.is4k ? media?.mediaUrl4k : media?.mediaUrl;
      const jellyfinItemId =
        getSettings().main.mediaServerType === MediaServerType.JELLYFIN
          ? occurrence.is4k
            ? media?.jellyfinMediaId4k
            : media?.jellyfinMediaId
          : undefined;
      let watchUrl: string | undefined;
      if (rawWatchUrl) {
        try {
          const parsed = new URL(rawWatchUrl);
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            watchUrl = parsed.toString();
          }
        } catch {
          // Ignore malformed external media-server URLs.
        }
      }
      items.push({
        id: occurrence.id,
        mediaType: occurrence.mediaType,
        source: occurrence.source,
        ...(isAdmin ? { sourceServerId: occurrence.sourceServerId } : {}),
        title: occurrence.title,
        subtitle: occurrence.subtitle ?? undefined,
        seasonNumber: occurrence.seasonNumber ?? undefined,
        episodeNumber: occurrence.episodeNumber ?? undefined,
        dateType: occurrence.dateType,
        ...(occurrence.source === 'radarr'
          ? {
              dates: movieDates.get(
                `${occurrence.sourceServerId}:${occurrence.sourceItemId}`
              ),
            }
          : {}),
        startsAt: occurrence.allDay
          ? occurrence.startsAt.toISOString().slice(0, 10)
          : occurrence.startsAt,
        allDay: occurrence.allDay,
        monitored: occurrence.monitored,
        available: occurrence.hasFile,
        watchUrl,
        jellyfinItemId,
        is4k: occurrence.is4k,
        // Sonarr occurrences store tvdb only; fall back to linked Media.tmdbId.
        tmdbId: occurrence.tmdbId ?? media?.tmdbId ?? undefined,
        detailUrl:
          occurrence.tmdbId || media?.tmdbId
            ? `/${occurrence.mediaType}/${occurrence.tmdbId ?? media?.tmdbId}`
            : undefined,
        ...(isAdmin && occurrence.sourceUrl
          ? { sourceUrl: occurrence.sourceUrl }
          : {}),
        requestedByCurrentUser: Boolean(currentUserRelevance),
        requestStatus: currentUserRelevance?.requestStatus,
        requestedQuality: currentUserRelevance
          ? occurrence.is4k
            ? '4k'
            : 'standard'
          : undefined,
        isNewSeason:
          occurrence.source === 'sonarr' &&
          occurrence.seasonNumber !== null &&
          occurrence.seasonNumber !== undefined &&
          occurrence.seasonNumber > 0 &&
          occurrence.episodeNumber === 1 &&
          Date.now() - occurrence.firstSeenAt.getTime() < 7 * 86400000,
        ...(latestChanges.has(occurrence.id)
          ? {
              previousStartsAt: latestChanges.get(occurrence.id)?.oldStartsAt
                ? occurrence.allDay
                  ? latestChanges
                      .get(occurrence.id)
                      ?.oldStartsAt?.toISOString()
                      .slice(0, 10)
                  : latestChanges.get(occurrence.id)?.oldStartsAt
                : undefined,
              changeKind: latestChanges.get(occurrence.id)?.changeKind,
            }
          : {}),
      });
    }

    const partialSources = releaseCalendarSync
      .getSourceStatuses()
      .filter((status) => status.lastErrorAt && !status.lastSuccessAt)
      .map((status) =>
        isAdmin
          ? { source: status.source, serverId: status.serverId }
          : { source: status.source }
      );
    return res.status(200).json({ results: items, partialSources });
  } catch (error) {
    return next(error);
  }
});

export default calendarRoutes;
