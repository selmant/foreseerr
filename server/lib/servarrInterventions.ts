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

/** Arr delete/blocklist can wait on the download client. Floor hangs, never unbounded. */
export const INTERVENTION_REJECTION_TIMEOUT_MS = 120_000;
/** Only a stuck-import safety net. In-progress can run for hours; 15m was the misleading idle look. */
export const INTERVENTION_IMPORT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export function interventionRejectionTimeout(
  configuredTimeout = getSettings().network.apiRequestTimeout
): number {
  if (configuredTimeout === 0) {
    return INTERVENTION_REJECTION_TIMEOUT_MS;
  }
  return Math.max(configuredTimeout, INTERVENTION_REJECTION_TIMEOUT_MS);
}

const isStaleInProgress = (
  record: ServarrIntervention,
  now: Date,
  timeoutMs: number
) => now.getTime() - new Date(record.updatedAt).getTime() >= timeoutMs;

async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error(message), { status: 504 }));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    void work.catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
      if (record.state === 'rejecting' || record.state === 'importing') {
        const timedOut = isStaleInProgress(
          record,
          now,
          record.state === 'importing'
            ? INTERVENTION_IMPORT_TIMEOUT_MS
            : interventionRejectionTimeout()
        );
        if (timedOut) {
          record.cleanupError =
            record.state === 'importing'
              ? 'Import timed out.'
              : 'Rejection timed out.';
          record.state = 'active';
          await repository.save(record);
        }
        continue;
      }
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
      record.resolution =
        record.state === 'importing'
          ? 'manual_import'
          : record.state === 'rejecting'
            ? record.actedByUserId
              ? 'manual_blocklist'
              : 'automatic_blocklist'
            : currentQueueIds.has(record.queueId)
              ? 'recovered'
              : 'disappeared';
      record.state = 'resolved';
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
        state: 'active',
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
  automatic = false,
  timeoutMs = interventionRejectionTimeout()
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
    {
      state: 'rejecting',
      cleanupError: null,
      ...(automatic ? {} : { actedByUserId: userId }),
    }
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
    await withTimeout(
      (async () => {
        const queue = (await client.getQueue()) as QueueWithMedia[];
        const exact = queue.find((item) => item.id === record.queueId);
        const media = await getRepository(Media).findOne({
          where: { id: record.mediaId },
        });
        if (
          !exact ||
          !media ||
          !isWarning(exact) ||
          externalIdFor(record.serviceType, exact) !==
            record.externalServiceId ||
          !mappedToService(media, record.serviceId, record.externalServiceId)
        ) {
          throw Object.assign(
            new Error(
              'The exact queue warning is no longer mapped and active.'
            ),
            { status: 409 }
          );
        }
        await client.removeQueueItem(record.queueId, { timeout: timeoutMs });
      })(),
      timeoutMs,
      'Rejection timed out.'
    );
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

export async function startImportedIntervention(
  id: number,
  userId: number
): Promise<void> {
  const repository = getRepository(ServarrIntervention);
  const claimed = await repository.update(
    { id, state: 'active' },
    { state: 'importing', actedByUserId: userId, cleanupError: null }
  );
  if (!claimed.affected) {
    throw Object.assign(new Error('This warning is already being handled.'), {
      status: 409,
    });
  }
}

export async function failImportedIntervention(
  id: number,
  message?: string
): Promise<void> {
  const repository = getRepository(ServarrIntervention);
  const record = await repository.findOne({ where: { id } });
  if (!record || record.state !== 'importing') return;
  record.state = 'active';
  record.cleanupError = (message ?? 'Manual import failed.').slice(0, 2000);
  await repository.save(record);
}

export async function resolveImportedIntervention(
  id: number,
  userId: number
): Promise<void> {
  const repository = getRepository(ServarrIntervention);
  const record = await repository.findOne({ where: { id } });
  if (!record || record.state === 'resolved' || record.state === 'rejecting')
    return;
  record.state = 'resolved';
  record.resolution = 'manual_import';
  record.actedByUserId = userId;
  record.resolvedAt = new Date();
  record.cleanupError = null;
  await repository.save(record);
}
