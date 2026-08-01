import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import type ReleaseDateChange from '@server/entity/ReleaseDateChange';
import type ReleaseOccurrence from '@server/entity/ReleaseOccurrence';
import { User } from '@server/entity/User';
import notificationManager, { Notification } from '@server/lib/notifications';
import logger from '@server/logger';
import { In } from 'typeorm';
import { getReleaseRelevance } from './relevance';

const NEW_SEASON_GRACE_MS = 7 * 86400000;

const selectedMovieDateType = (occurrence: ReleaseOccurrence) => {
  let dates: Record<string, unknown> = {};
  try {
    dates = occurrence.rawDates ? JSON.parse(occurrence.rawDates) : {};
  } catch {
    // Fall through to the persisted occurrence type.
  }
  const present = new Set<string>();
  if (dates.digitalRelease) present.add('digital');
  if (dates.physicalRelease) present.add('physical');
  if (dates.inCinemas) present.add('theatrical');
  return (
    ['digital', 'physical', 'theatrical'].find((dateType) =>
      present.has(dateType)
    ) ?? occurrence.dateType
  );
};

const notificationContext = async (occurrence: ReleaseOccurrence) => {
  const relevance = await getReleaseRelevance(occurrence);
  const userIds = [...new Set(relevance.map((item) => item.userId))];
  const [users, media] = await Promise.all([
    userIds.length
      ? getRepository(User).find({
          where: { id: In(userIds) },
          relations: { settings: true },
        })
      : [],
    occurrence.mediaId
      ? getRepository(Media).findOneBy({ id: occurrence.mediaId })
      : null,
  ]);
  return { users, media };
};

const isoDate = (date?: Date | null) => date?.toISOString().slice(0, 10);

const dateChangeMessage = (
  occurrence: ReleaseOccurrence,
  change: ReleaseDateChange
) => {
  const oldDate = isoDate(change.oldStartsAt);
  const newDate = isoDate(change.newStartsAt);
  if (change.changeKind === 'withdrawn') {
    return `The ${occurrence.dateType} release date${oldDate ? ` (${oldDate})` : ''} was withdrawn.`;
  }
  if (change.changeKind === 'announced') {
    return `A ${occurrence.dateType} release date was announced${newDate ? ` for ${newDate}` : ''}.`;
  }
  return `The ${occurrence.dateType} release moved from ${oldDate ?? 'an earlier date'} to ${newDate ?? 'a new date'}.`;
};

export const produceReleaseDateChangeEvents = async (
  occurrence: ReleaseOccurrence,
  change: ReleaseDateChange
): Promise<void> => {
  if (!change.notifiable) return;
  if (
    occurrence.source === 'radarr' &&
    selectedMovieDateType(occurrence) !== occurrence.dateType
  ) {
    return;
  }
  const { users, media } = await notificationContext(occurrence);
  for (const user of users) {
    notificationManager.sendNotification(Notification.RELEASE_DATE_CHANGED, {
      event: 'Release Date Changed',
      subject: occurrence.title,
      message: dateChangeMessage(occurrence, change),
      notifyAdmin: false,
      notifySystem: true,
      notifyUser: user,
      media: media ?? undefined,
    });
  }
};

export const produceNewSeasonEvents = async (
  occurrence: ReleaseOccurrence,
  now = new Date()
): Promise<void> => {
  if (
    occurrence.source !== 'sonarr' ||
    !occurrence.seasonNumber ||
    occurrence.episodeNumber !== 1 ||
    occurrence.startsAt.getTime() < now.getTime() - NEW_SEASON_GRACE_MS
  ) {
    return;
  }
  const { users, media } = await notificationContext(occurrence);
  for (const user of users) {
    notificationManager.sendNotification(Notification.NEW_SEASON, {
      event: 'New Season Announced',
      subject: occurrence.title,
      message: `Season ${occurrence.seasonNumber} premieres ${isoDate(occurrence.startsAt)}.`,
      notifyAdmin: false,
      notifySystem: true,
      notifyUser: user,
      media: media ?? undefined,
    });
  }
};

export const safelyProduceReleaseEvents = async (input: {
  dateChanges: { occurrence: ReleaseOccurrence; change: ReleaseDateChange }[];
  newSeasons: ReleaseOccurrence[];
}): Promise<void> => {
  const tasks = [
    ...input.dateChanges.map(({ occurrence, change }) =>
      produceReleaseDateChangeEvents(occurrence, change)
    ),
    ...input.newSeasons.map((occurrence) => produceNewSeasonEvents(occurrence)),
  ];
  const results = await Promise.allSettled(tasks);
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) {
    logger.warn('Some release notifications could not be sent', {
      label: 'Release Calendar Sync',
      failed: failures.length,
    });
  }
};
