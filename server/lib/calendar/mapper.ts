import { MediaServerType } from '@server/constants/server';
import type Media from '@server/entity/Media';
import type ReleaseDateChange from '@server/entity/ReleaseDateChange';
import type ReleaseOccurrence from '@server/entity/ReleaseOccurrence';
import type { CalendarItem } from '@server/interfaces/api/calendarInterfaces';
import type { ReleaseRelevance } from '@server/lib/releases/relevance';
import { getSettings } from '@server/lib/settings';
import { safeExternalHttpUrl } from './query';

type CalendarMappingContext = {
  userId?: number;
  isAdmin: boolean;
  mediaById: Map<number, Media>;
  latestChanges: Map<number, ReleaseDateChange>;
  relevanceByOccurrence: Map<number, ReleaseRelevance[]>;
};

const occurrenceKey = (occurrence: ReleaseOccurrence) =>
  `${occurrence.sourceServerId}:${occurrence.sourceItemId}`;

export const collectMovieDates = (occurrences: ReleaseOccurrence[]) => {
  const movieDates = new Map<string, NonNullable<CalendarItem['dates']>>();
  for (const occurrence of occurrences) {
    if (occurrence.source !== 'radarr') continue;
    const key = occurrenceKey(occurrence);
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
  return movieDates;
};

export function mapCalendarOccurrence(
  occurrence: ReleaseOccurrence,
  movieDates: ReturnType<typeof collectMovieDates>,
  context: CalendarMappingContext
): CalendarItem | undefined {
  const relevance = context.relevanceByOccurrence.get(occurrence.id) ?? [];
  const currentUserRelevance = relevance.find(
    (item) => item.userId === context.userId
  );
  const media = occurrence.mediaId
    ? context.mediaById.get(occurrence.mediaId)
    : undefined;
  const rawWatchUrl = occurrence.is4k ? media?.mediaUrl4k : media?.mediaUrl;
  const jellyfinItemId =
    getSettings().main.mediaServerType === MediaServerType.JELLYFIN
      ? occurrence.is4k
        ? media?.jellyfinMediaId4k
        : media?.jellyfinMediaId
      : undefined;
  const latestChange = context.latestChanges.get(occurrence.id);
  return {
    id: occurrence.id,
    mediaType: occurrence.mediaType,
    source: occurrence.source,
    ...(context.isAdmin ? { sourceServerId: occurrence.sourceServerId } : {}),
    title: occurrence.title,
    subtitle: occurrence.subtitle ?? undefined,
    seasonNumber: occurrence.seasonNumber ?? undefined,
    episodeNumber: occurrence.episodeNumber ?? undefined,
    dateType: occurrence.dateType,
    ...(occurrence.source === 'radarr'
      ? { dates: movieDates.get(occurrenceKey(occurrence)) }
      : {}),
    startsAt: occurrence.allDay
      ? occurrence.startsAt.toISOString().slice(0, 10)
      : occurrence.startsAt.toISOString(),
    allDay: occurrence.allDay,
    monitored: occurrence.monitored,
    available: occurrence.hasFile,
    watchUrl: safeExternalHttpUrl(rawWatchUrl),
    jellyfinItemId,
    is4k: occurrence.is4k,
    tmdbId: occurrence.tmdbId ?? media?.tmdbId ?? undefined,
    detailUrl:
      occurrence.tmdbId || media?.tmdbId
        ? `/${occurrence.mediaType}/${occurrence.tmdbId ?? media?.tmdbId}`
        : undefined,
    ...(context.isAdmin && occurrence.sourceUrl
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
    ...(latestChange
      ? {
          previousStartsAt: latestChange.oldStartsAt
            ? occurrence.allDay
              ? latestChange.oldStartsAt.toISOString().slice(0, 10)
              : latestChange.oldStartsAt.toISOString()
            : undefined,
          changeKind: latestChange.changeKind,
        }
      : {}),
  };
}
