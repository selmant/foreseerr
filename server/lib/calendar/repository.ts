import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import ReleaseDateChange from '@server/entity/ReleaseDateChange';
import ReleaseOccurrence from '@server/entity/ReleaseOccurrence';
import { In } from 'typeorm';
import type { CalendarFilters } from './types';

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

export async function findCalendarOccurrences(filters: CalendarFilters) {
  const query = getRepository(ReleaseOccurrence)
    .createQueryBuilder('occurrence')
    .where('occurrence.startsAt >= :start AND occurrence.startsAt < :end', {
      start: filters.start,
      end: filters.end,
    })
    .andWhere('occurrence.missingSince IS NULL');
  if (!filters.includeUnmonitored) {
    query.andWhere('occurrence.monitored = :monitored', { monitored: true });
  }
  if (filters.mediaType) {
    query.andWhere('occurrence.mediaType = :mediaType', {
      mediaType: filters.mediaType,
    });
  }
  if (filters.source) {
    query.andWhere('occurrence.source = :source', { source: filters.source });
  }
  if (filters.serverId) {
    query.andWhere('occurrence.sourceServerId = :serverId', {
      serverId: filters.serverId,
    });
  }
  if (filters.is4k !== undefined) {
    query.andWhere('occurrence.is4k = :is4k', { is4k: filters.is4k });
  }
  if (!filters.includeEpisodes) {
    query.andWhere(
      '(occurrence.mediaType = :movie OR occurrence.episodeNumber = 1)',
      { movie: 'movie' }
    );
  }
  return query.orderBy('occurrence.startsAt', 'ASC').getMany();
}

export async function findCalendarJoinData(occurrences: ReleaseOccurrence[]) {
  const occurrenceIds = occurrences.map((occurrence) => occurrence.id);
  const changes = occurrenceIds.length
    ? await getRepository(ReleaseDateChange).find({
        where: { occurrenceId: In(occurrenceIds) },
        order: { detectedAt: 'DESC' },
      })
    : [];
  const latestChanges = new Map<number, ReleaseDateChange>();
  for (const change of changes) {
    if (!latestChanges.has(change.occurrenceId)) {
      latestChanges.set(change.occurrenceId, change);
    }
  }

  const mediaIds = [
    ...new Set(
      occurrences
        .map((occurrence) => occurrence.mediaId)
        .filter((id): id is number => id !== null && id !== undefined)
    ),
  ];
  const media = mediaIds.length
    ? await getRepository(Media).findBy({ id: In(mediaIds) })
    : [];
  return {
    latestChanges,
    mediaById: new Map(media.map((item) => [item.id, item])),
  };
}
