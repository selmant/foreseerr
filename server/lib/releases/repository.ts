import { MediaType } from '@server/constants/media';
import dataSource from '@server/datasource';
import Media from '@server/entity/Media';
import ReleaseDateChange from '@server/entity/ReleaseDateChange';
import ReleaseOccurrence, {
  type ReleaseSource,
} from '@server/entity/ReleaseOccurrence';
import { In, LessThan } from 'typeorm';
import { isMaterialDateChange, occurrenceKey } from './normalization';
import type { NormalizedOccurrence, ReleaseCalendarSyncResult } from './types';

const MISSING_GRACE_DAYS = 7;
const CHANGE_RETENTION_DAYS = 365;

export interface DiscoveredReleaseEvents {
  dateChanges: {
    occurrence: ReleaseOccurrence;
    change: ReleaseDateChange;
  }[];
  newSeasons: ReleaseOccurrence[];
}

const uniqueNumbers = (values: (number | undefined)[]) => [
  ...new Set(values.filter((value): value is number => value !== undefined)),
];

const inRange = (date: Date, start: Date, end: Date) =>
  date >= start && date <= end;

const isSeasonPremiere = (occurrence: ReleaseOccurrence) =>
  occurrence.source === 'sonarr' &&
  (occurrence.seasonNumber ?? 0) > 0 &&
  occurrence.episodeNumber === 1;

export const reconcileServerOccurrences = async (input: {
  source: ReleaseSource;
  sourceServerId: number;
  occurrences: NormalizedOccurrence[];
  start: Date;
  end: Date;
  result: ReleaseCalendarSyncResult;
}): Promise<DiscoveredReleaseEvents> =>
  dataSource.transaction(async (manager) => {
    const occurrenceRepository = manager.getRepository(ReleaseOccurrence);
    const mediaRepository = manager.getRepository(Media);
    const changeRepository = manager.getRepository(ReleaseDateChange);
    const now = new Date();
    const missingCutoff = new Date(
      now.getTime() - MISSING_GRACE_DAYS * 86400000
    );

    const existingRows = await occurrenceRepository.find({
      where: {
        source: input.source,
        sourceServerId: input.sourceServerId,
      },
    });
    const existingByKey = new Map(
      existingRows.map((occurrence) => [occurrenceKey(occurrence), occurrence])
    );
    const initialBackfill = existingRows.length === 0;

    const movieIds = uniqueNumbers(
      input.occurrences.map((occurrence) => occurrence.tmdbId)
    );
    const seriesIds = uniqueNumbers(
      input.occurrences.map((occurrence) => occurrence.sourceSeriesTvdbId)
    );
    const [movies, series] = await Promise.all([
      movieIds.length
        ? mediaRepository.find({
            where: { tmdbId: In(movieIds), mediaType: MediaType.MOVIE },
          })
        : [],
      seriesIds.length
        ? mediaRepository.find({
            where: { tvdbId: In(seriesIds), mediaType: MediaType.TV },
          })
        : [],
    ]);
    const moviesByTmdbId = new Map(
      movies.map((media) => [media.tmdbId, media])
    );
    const seriesByTvdbId = new Map(
      series.map((media) => [media.tvdbId, media])
    );

    const inserted = new Set<string>();
    const moved = new Map<string, Date>();
    const toSave = input.occurrences.map((normalized) => {
      const key = occurrenceKey(normalized);
      const existing = existingByKey.get(key);
      const media = normalized.tmdbId
        ? moviesByTmdbId.get(normalized.tmdbId)
        : normalized.sourceSeriesTvdbId
          ? seriesByTvdbId.get(normalized.sourceSeriesTvdbId)
          : undefined;
      if (!media) input.result.unmapped += 1;

      const occurrence = existing ?? occurrenceRepository.create();
      if (!existing) inserted.add(key);
      if (existing && isMaterialDateChange(existing, normalized)) {
        moved.set(key, existing.startsAt);
      }
      const persisted = { ...normalized };
      delete persisted.sourceSeriesTvdbId;
      Object.assign(occurrence, persisted, {
        mediaId: media?.id ?? null,
        firstSeenAt: existing?.firstSeenAt ?? now,
        lastSeenAt: now,
        missingSince: null,
      });
      return occurrence;
    });
    const saved = toSave.length ? await occurrenceRepository.save(toSave) : [];
    input.result.inserted += inserted.size;

    const events: DiscoveredReleaseEvents = {
      dateChanges: [],
      newSeasons: [],
    };
    for (const occurrence of saved) {
      const key = occurrenceKey(occurrence);
      if (inserted.has(key)) {
        if (!initialBackfill && occurrence.source === 'radarr') {
          const change = changeRepository.create({
            occurrenceId: occurrence.id,
            oldStartsAt: null,
            newStartsAt: occurrence.startsAt,
            changeKind: 'announced',
            detectedAt: now,
            notifiable: true,
            metadata: JSON.stringify({
              source: input.source,
              dateType: occurrence.dateType,
            }),
          });
          events.dateChanges.push({ occurrence, change });
        }
        if (!initialBackfill && isSeasonPremiere(occurrence)) {
          events.newSeasons.push(occurrence);
        }
      } else {
        const oldStartsAt = moved.get(key);
        if (oldStartsAt) {
          const change = changeRepository.create({
            occurrenceId: occurrence.id,
            oldStartsAt,
            newStartsAt: occurrence.startsAt,
            changeKind:
              occurrence.startsAt < oldStartsAt ? 'moved_earlier' : 'delayed',
            detectedAt: now,
            notifiable: true,
            metadata: JSON.stringify({
              source: input.source,
              dateType: occurrence.dateType,
            }),
          });
          events.dateChanges.push({ occurrence, change });
        }
      }
    }
    if (events.dateChanges.length) {
      const savedChanges = await changeRepository.save(
        events.dateChanges.map(({ change }) => change)
      );
      events.dateChanges.forEach((event, index) => {
        event.change = savedChanges[index];
      });
      input.result.changed += savedChanges.length;
    }

    const seen = new Set(input.occurrences.map(occurrenceKey));
    const newlyMissing = existingRows.filter(
      (occurrence) =>
        !occurrence.missingSince &&
        inRange(occurrence.startsAt, input.start, input.end) &&
        !seen.has(occurrenceKey(occurrence))
    );
    if (newlyMissing.length) {
      newlyMissing.forEach((occurrence) => (occurrence.missingSince = now));
      await occurrenceRepository.save(newlyMissing);
      input.result.missing += newlyMissing.length;
    }

    const expiredMissing = await occurrenceRepository.find({
      where: {
        source: input.source,
        sourceServerId: input.sourceServerId,
        missingSince: LessThan(missingCutoff),
      },
    });
    const expiredIds = expiredMissing.map((occurrence) => occurrence.id);
    if (expiredIds.length) {
      const withdrawn = await changeRepository.find({
        where: {
          occurrenceId: In(expiredIds),
          changeKind: 'withdrawn',
        },
      });
      const withdrawnIds = new Set(
        withdrawn.map((change) => change.occurrenceId)
      );
      const withdrawals = expiredMissing
        .filter((occurrence) => !withdrawnIds.has(occurrence.id))
        .map((occurrence) => ({
          occurrence,
          change: changeRepository.create({
            occurrenceId: occurrence.id,
            oldStartsAt: occurrence.startsAt,
            newStartsAt: null,
            changeKind: 'withdrawn',
            detectedAt: now,
            notifiable: true,
            metadata: JSON.stringify({
              source: input.source,
              dateType: occurrence.dateType,
            }),
          }),
        }));
      if (withdrawals.length) {
        const savedWithdrawals = await changeRepository.save(
          withdrawals.map(({ change }) => change)
        );
        withdrawals.forEach((event, index) => {
          event.change = savedWithdrawals[index];
        });
        events.dateChanges.push(...withdrawals);
        input.result.changed += withdrawals.length;
      }
    }

    await changeRepository.delete({
      detectedAt: LessThan(
        new Date(now.getTime() - CHANGE_RETENTION_DAYS * 86400000)
      ),
    });
    if (expiredIds.length) {
      const retainedChanges = await changeRepository.find({
        where: { occurrenceId: In(expiredIds) },
      });
      const retainedIds = new Set(
        retainedChanges.map((change) => change.occurrenceId)
      );
      const deletableIds = expiredIds.filter((id) => !retainedIds.has(id));
      if (deletableIds.length) {
        await occurrenceRepository.delete({ id: In(deletableIds) });
      }
    }

    return events;
  });
