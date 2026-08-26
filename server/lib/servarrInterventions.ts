import type { QueueItem } from '@server/api/servarr/base';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  ServarrIntervention,
  type ServarrInterventionService,
} from '@server/entity/ServarrIntervention';
import { getSettings, type DVRSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { In } from 'typeorm';

type QueueWithMedia = QueueItem & { movieId?: number; seriesId?: number };

const warningMessages = (item: QueueWithMedia): string[] => {
  const details = item as QueueWithMedia & {
    statusMessages?: { title?: string; messages?: string[] }[];
  };
  return (details.statusMessages ?? []).flatMap((status) =>
    (status.messages?.length ? status.messages : [status.title])
      .filter((message): message is string => !!message)
      .map((message) => message.slice(0, 1000))
  );
};

const isWarning = (item: QueueWithMedia): boolean =>
  item.trackedDownloadStatus?.toLowerCase() === 'warning';

const isManualImportCapable = (item: QueueWithMedia): boolean =>
  item.status?.toLowerCase() === 'completed' &&
  !!item.downloadId &&
  !!item.outputPath;

const externalIdFor = (
  type: ServarrInterventionService,
  item: QueueWithMedia
): number | undefined => (type === 'radarr' ? item.movieId : item.seriesId);

const mappedToService = (
  media: Media,
  serviceId: number,
  externalId: number
): boolean =>
  (media.serviceId === serviceId && media.externalServiceId === externalId) ||
  (media.serviceId4k === serviceId && media.externalServiceId4k === externalId);

const clientFor = (type: ServarrInterventionService, server: DVRSettings) =>
  type === 'radarr'
    ? new RadarrAPI({
        apiKey: server.apiKey,
        url: RadarrAPI.buildUrl(server, '/api/v3'),
      })
    : new SonarrAPI({
        apiKey: server.apiKey,
        url: SonarrAPI.buildUrl(server, '/api/v3'),
      });

const serverFor = (type: ServarrInterventionService, serviceId: number) => {
  const settings = getSettings();
  return (type === 'radarr' ? settings.radarr : settings.sonarr).find(
    (server) => server.id === serviceId && server.syncEnabled
  );
};

export const publicIntervention = (item: ServarrIntervention) => ({
  id: item.id,
  serviceType: item.serviceType,
  serviceId: item.serviceId,
  serviceName: item.serviceName,
  is4k: item.is4k,
  mediaId: item.mediaId,
  tmdbId: item.tmdbId,
  mediaType: item.mediaType,
  releaseTitle: item.releaseTitle,
  warningMessages: item.warningMessages,
  manualImportCapable: item.manualImportCapable,
  state: item.state,
  resolution: item.resolution,
  cleanupError: item.cleanupError,
  firstSeenAt: item.firstSeenAt,
  cleanupDeadlineAt: item.cleanupDeadlineAt,
  resolvedAt: item.resolvedAt,
});

/** Reconcile only after a successful poll. A failed service poll must do nothing. */
export async function reconcileServarrWarnings(
  type: ServarrInterventionService,
  server: DVRSettings,
  queue: QueueWithMedia[],
  now = new Date()
): Promise<void> {
  const repository = getRepository(ServarrIntervention);
  const externalIds = [
    ...new Set(
      queue
        .map((item) => externalIdFor(type, item))
        .filter((id): id is number => Number.isInteger(id))
    ),
  ];
  const media = externalIds.length
    ? await getRepository(Media).find({
        where: [
          {
            mediaType: type === 'radarr' ? MediaType.MOVIE : MediaType.TV,
            serviceId: server.id,
          },
          {
            mediaType: type === 'radarr' ? MediaType.MOVIE : MediaType.TV,
            serviceId4k: server.id,
          },
        ],
      })
    : [];
  const mapped = new Map<number, { media: Media; is4k: boolean }>();
  for (const item of media) {
    for (const externalId of externalIds) {
      if (mappedToService(item, server.id, externalId)) {
        mapped.set(externalId, {
          media: item,
          is4k:
            item.serviceId4k === server.id &&
            item.externalServiceId4k === externalId,
        });
      }
    }
  }

  const existing = await repository.find({
    where: { serviceType: type, serviceId: server.id },
  });
  const byQueueId = new Map(
    existing
      .filter((item) => item.state !== 'resolved')
      .map((item) => [item.queueId, item])
  );
  const currentQueueIds = new Set(queue.map((item) => item.id));
  const currentWarnings = new Set<number>();
  const graceHours = getSettings().servarrInterventions.cleanupGraceHours;

  for (const queueItem of queue) {
    const externalId = externalIdFor(type, queueItem);
    const mapping = externalId == null ? undefined : mapped.get(externalId);
    if (!mapping || !isWarning(queueItem)) continue;
    const mediaItem = mapping.media;
    currentWarnings.add(queueItem.id);
    const record = byQueueId.get(queueItem.id);
    if (record) {
      if (record.state === 'rejecting') record.state = 'active';
      if (record.state !== 'resolved') {
        record.releaseTitle = queueItem.title.slice(0, 500);
        record.warningMessages = warningMessages(queueItem);
        record.manualImportCapable = isManualImportCapable(queueItem);
        record.downloadId = queueItem.downloadId || null;
        record.outputPath = queueItem.outputPath || null;
        await repository.save(record);
      }
      continue;
    }
    await repository.save(
      new ServarrIntervention({
        serviceType: type,
        serviceId: server.id,
        serviceName: server.name,
        is4k: mapping.is4k,
        queueId: queueItem.id,
        downloadId: queueItem.downloadId || null,
        outputPath: queueItem.outputPath || null,
        externalServiceId: externalId!,
        mediaId: mediaItem.id,
        tmdbId: mediaItem.tmdbId,
        mediaType: mediaItem.mediaType,
        releaseTitle: queueItem.title.slice(0, 500),
        warningMessages: warningMessages(queueItem),
        manualImportCapable: isManualImportCapable(queueItem),
        state: 'active',
        firstSeenAt: now,
        cleanupDeadlineAt: new Date(
          now.getTime() + graceHours * 60 * 60 * 1000
        ),
      })
    );
  }

  for (const record of existing.filter((item) => item.state !== 'resolved')) {
    if (!currentWarnings.has(record.queueId)) {
      record.state = 'resolved';
      record.resolution = currentQueueIds.has(record.queueId)
        ? 'recovered'
        : 'disappeared';
      record.resolvedAt = now;
      record.cleanupError = null;
      await repository.save(record);
    }
  }

  if (getSettings().servarrInterventions.automaticCleanupEnabled) {
    const overdue = await repository.find({
      where: {
        serviceType: type,
        serviceId: server.id,
        state: In(['active', 'rejecting']),
      },
    });
    for (const record of overdue) {
      if (record.cleanupDeadlineAt <= now) {
        try {
          await rejectServarrIntervention(record.id, undefined, true);
        } catch {
          // The rejection helper persists the error and returns the record to
          // active. One failed item must not prevent reconciliation or retries
          // for the rest of this successfully-polled service.
        }
      }
    }
  }
}

export async function rejectServarrIntervention(
  id: number,
  userId?: number,
  automatic = false
): Promise<ServarrIntervention> {
  const repository = getRepository(ServarrIntervention);
  const record = await repository.findOne({ where: { id } });
  if (!record)
    throw Object.assign(new Error('Intervention not found.'), { status: 404 });
  if (record.state === 'resolved') {
    if (record.resolution?.endsWith('_blocklist')) return record;
    throw Object.assign(new Error('This warning is no longer active.'), {
      status: 409,
    });
  }
  const claimed = await repository.update(
    { id: record.id, state: 'active' },
    { state: 'rejecting', cleanupError: null }
  );
  if (!claimed.affected) {
    throw Object.assign(new Error('This warning is already being rejected.'), {
      status: 409,
    });
  }
  record.state = 'rejecting';
  record.cleanupError = null;

  try {
    const server = serverFor(record.serviceType, record.serviceId);
    if (!server)
      throw Object.assign(
        new Error('The mapped Arr service is disabled or missing.'),
        { status: 409 }
      );
    const client = clientFor(record.serviceType, server);
    const queue = (await client.getQueue()) as QueueWithMedia[];
    const exact = queue.find((item) => item.id === record.queueId);
    const media = await getRepository(Media).findOne({
      where: { id: record.mediaId },
    });
    if (
      !exact ||
      !media ||
      !isWarning(exact) ||
      externalIdFor(record.serviceType, exact) !== record.externalServiceId ||
      !mappedToService(media, record.serviceId, record.externalServiceId)
    ) {
      throw Object.assign(
        new Error('The exact queue warning is no longer mapped and active.'),
        { status: 409 }
      );
    }
    await client.removeQueueItem(record.queueId);
    record.state = 'resolved';
    record.resolution = automatic ? 'automatic_blocklist' : 'manual_blocklist';
    record.actedByUserId = automatic ? null : userId;
    record.resolvedAt = new Date();
    record.cleanupError = null;
    return await repository.save(record);
  } catch (error) {
    record.state = 'active';
    record.cleanupError =
      error instanceof Error
        ? error.message.slice(0, 2000)
        : 'Arr rejection failed.';
    await repository.save(record);
    logger.error('Unable to reject Servarr intervention', {
      label: 'Servarr Interventions',
      interventionId: id,
      errorMessage: record.cleanupError,
    });
    if (
      error &&
      typeof error === 'object' &&
      'status' in error &&
      typeof error.status === 'number'
    ) {
      throw error;
    }
    throw Object.assign(
      error instanceof Error ? error : new Error('Arr rejection failed.'),
      { status: 502 }
    );
  }
}

export async function resolveImportedIntervention(
  id: number,
  userId: number
): Promise<void> {
  const repository = getRepository(ServarrIntervention);
  const record = await repository.findOne({ where: { id } });
  if (!record || record.state === 'resolved') return;
  record.state = 'resolved';
  record.resolution = 'manual_import';
  record.actedByUserId = userId;
  record.resolvedAt = new Date();
  record.cleanupError = null;
  await repository.save(record);
}
