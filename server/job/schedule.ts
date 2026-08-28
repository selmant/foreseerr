import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import { JobExecutionState } from '@server/entity/JobExecutionState';
import blocklistedTagsProcessor from '@server/job/blocklistedTagsProcessor';
import { canRunLaunchCatchUp } from '@server/job/catchup';
import episodeRequestSync from '@server/job/episodeRequestSync';
import {
  cancelManagedJobs,
  executeManagedJob,
  type ManagedJobWeight,
} from '@server/job/execution';
import availabilitySync from '@server/lib/availabilitySync';
import {
  isDesktopPlaybackActive,
  isDesktopRuntime,
} from '@server/lib/desktopState';
import downloadTracker from '@server/lib/downloadtracker';
import ImageProxy from '@server/lib/imageproxy';
import { ensureMappingPacks } from '@server/lib/mapping/bootstrap';
import { suggestForOpenGaps } from '@server/lib/mapping/heuristic';
import { backfillMappingGaps } from '@server/lib/mapping/live';
import refreshToken from '@server/lib/refreshToken';
import releaseCalendarSync from '@server/lib/releases/sync';
import {
  jellyfinFullScanner,
  jellyfinRecentScanner,
} from '@server/lib/scanners/jellyfin';
import { plexFullScanner, plexRecentScanner } from '@server/lib/scanners/plex';
import { radarrScanner } from '@server/lib/scanners/radarr';
import { sonarrScanner } from '@server/lib/scanners/sonarr';
import type { JobId } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import watchlistSync from '@server/lib/watchlistsync';
import logger from '@server/logger';
import schedule from 'node-schedule';

interface ScheduledJob {
  id: JobId;
  job: schedule.Job;
  name: string;
  type: 'process' | 'command';
  interval: 'seconds' | 'minutes' | 'hours' | 'days' | 'fixed';
  cronSchedule: string;
  running?: () => boolean;
  cancelFn?: () => void;
}

export const scheduledJobs: ScheduledJob[] = [];

const heavyJobIds = new Set<JobId>([
  'plex-recently-added-scan',
  'plex-full-scan',
  'jellyfin-recently-added-scan',
  'jellyfin-full-scan',
  'radarr-scan',
  'sonarr-scan',
  'availability-sync',
  'process-blocklisted-tags',
  'mapping-backfill',
]);
let desktopCatchUpTimer: NodeJS.Timeout | undefined;
let desktopDownloadStartupRun = false;
const deferredHeavyJobs = new Map<
  JobId,
  { name: string; run: () => Promise<unknown> }
>();

const runScheduledJob = (
  id: JobId,
  weight: ManagedJobWeight,
  name: string,
  run: () => Promise<unknown>
): Promise<boolean> => {
  if (weight === 'heavy' && isDesktopPlaybackActive()) {
    // Cron may fire repeatedly while a film is playing. Coalesce by job ID;
    // a single run is retained for the first 30-second idle window after
    // playback stops rather than replaying every missed occurrence.
    deferredHeavyJobs.set(id, { name, run });
    logger.info(
      `Deferring heavy job while desktop playback is active: ${name}`,
      {
        label: 'Jobs',
      }
    );
    return Promise.resolve(false);
  }
  return executeManagedJob(id, weight, () => run()).catch((error) => {
    logger.error(`Failed to record scheduled job: ${name}`, {
      label: 'Jobs',
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  });
};

const runHeavy = (id: JobId, name: string, run: () => Promise<unknown>) =>
  runScheduledJob(id, 'heavy', name, run);

const runScheduledJobById = (id: JobId): Promise<boolean> => {
  switch (id) {
    case 'plex-recently-added-scan':
      return runHeavy(id, 'Plex Recently Added Scan', () =>
        plexRecentScanner.run()
      );
    case 'plex-full-scan':
      return runHeavy(id, 'Plex Full Library Scan', () =>
        plexFullScanner.run()
      );
    case 'plex-refresh-token':
      return runScheduledJob(id, 'light', 'Plex Refresh Token', () =>
        refreshToken.run()
      );
    case 'plex-watchlist-sync':
      return runScheduledJob(id, 'light', 'Plex Watchlist Sync', () =>
        watchlistSync.syncWatchlist()
      );
    case 'jellyfin-recently-added-scan':
      return runHeavy(id, 'Jellyfin Recently Added Scan', () =>
        jellyfinRecentScanner.run()
      );
    case 'jellyfin-full-scan':
      return runHeavy(id, 'Jellyfin Full Scan', () =>
        jellyfinFullScanner.run()
      );
    case 'radarr-scan':
      return runHeavy(id, 'Radarr Scan', () => radarrScanner.run());
    case 'episode-request-sync':
      return runScheduledJob(id, 'light', 'Episode Request Sync', () =>
        episodeRequestSync.run()
      );
    case 'release-calendar-sync':
      return runScheduledJob(id, 'light', 'Release Calendar Sync', () =>
        releaseCalendarSync.run()
      );
    case 'sonarr-scan':
      return runHeavy(id, 'Sonarr Scan', () => sonarrScanner.run());
    case 'availability-sync':
      return runHeavy(id, 'Media Availability Sync', () =>
        availabilitySync.run()
      );
    case 'download-sync':
      return runScheduledJob(id, 'light', 'Download Sync', () =>
        downloadTracker.updateDownloads()
      );
    case 'download-sync-reset':
      return runScheduledJob(id, 'light', 'Download Sync Reset', () =>
        downloadTracker.resetDownloadTracker()
      );
    case 'image-cache-cleanup':
      return runScheduledJob(id, 'light', 'Image Cache Cleanup', async () => {
        ImageProxy.clearCache('tmdb');
        ImageProxy.clearCache('avatar');
        await ImageProxy.maintainCache();
      });
    case 'process-blocklisted-tags':
      return runHeavy(id, 'Process Blocklisted Tags', () =>
        blocklistedTagsProcessor.run()
      );
    case 'mapping-pack-refresh':
      return runScheduledJob(id, 'light', 'Mapping Pack Refresh', () =>
        ensureMappingPacks({ force: true, ingest: true })
      );
    case 'mapping-backfill':
      // Heavy: it spends the daily MDBList quota and then walks the queue with
      // title matching, so it must not overlap a library scan.
      return runHeavy(id, 'Mapping Gap Backfill', async () => {
        await backfillMappingGaps();
        await suggestForOpenGaps({ limit: 100 });
      });
    default:
      return Promise.resolve(false);
  }
};

const runDeferredHeavyJobs = async (): Promise<void> => {
  if (isDesktopPlaybackActive()) return;
  const jobs = [...deferredHeavyJobs];
  deferredHeavyJobs.clear();
  for (const [id, { name, run }] of jobs) {
    logger.info(`Resuming heavy job deferred by desktop playback: ${name}`, {
      label: 'Jobs',
    });
    // Unlike ordinary cron callbacks, this drain intentionally waits for one
    // heavy job before beginning the next. Calling them all at once would
    // cause the shared executor to reject every job after the first.
    await executeManagedJob(id, 'heavy', () => run());
  }
};

export const startJobs = (): void => {
  if (scheduledJobs.length > 0) {
    return;
  }
  const jobs = getSettings().jobs;
  const mediaServerType = getSettings().main.mediaServerType;

  if (mediaServerType === MediaServerType.PLEX) {
    // Run recently added plex scan every 5 minutes
    scheduledJobs.push({
      id: 'plex-recently-added-scan',
      name: 'Plex Recently Added Scan',
      type: 'process',
      interval: 'minutes',
      cronSchedule: jobs['plex-recently-added-scan'].schedule,
      job: schedule.scheduleJob(
        jobs['plex-recently-added-scan'].schedule,
        () => {
          logger.info('Starting scheduled job: Plex Recently Added Scan', {
            label: 'Jobs',
          });
          void runScheduledJobById('plex-recently-added-scan');
        }
      ),
      running: () => plexRecentScanner.status().running,
      cancelFn: () => plexRecentScanner.cancel(),
    });

    // Run full plex scan every 24 hours
    scheduledJobs.push({
      id: 'plex-full-scan',
      name: 'Plex Full Library Scan',
      type: 'process',
      interval: 'hours',
      cronSchedule: jobs['plex-full-scan'].schedule,
      job: schedule.scheduleJob(jobs['plex-full-scan'].schedule, () => {
        logger.info('Starting scheduled job: Plex Full Library Scan', {
          label: 'Jobs',
        });
        void runScheduledJobById('plex-full-scan');
      }),
      running: () => plexFullScanner.status().running,
      cancelFn: () => plexFullScanner.cancel(),
    });

    scheduledJobs.push({
      id: 'plex-refresh-token',
      name: 'Plex Refresh Token',
      type: 'process',
      interval: 'fixed',
      cronSchedule: jobs['plex-refresh-token'].schedule,
      job: schedule.scheduleJob(jobs['plex-refresh-token'].schedule, () => {
        logger.info('Starting scheduled job: Plex Refresh Token', {
          label: 'Jobs',
        });
        void runScheduledJobById('plex-refresh-token');
      }),
    });

    // Watchlist Sync
    scheduledJobs.push({
      id: 'plex-watchlist-sync',
      name: 'Plex Watchlist Sync',
      type: 'process',
      interval: 'seconds',
      cronSchedule: jobs['plex-watchlist-sync'].schedule,
      job: schedule.scheduleJob(jobs['plex-watchlist-sync'].schedule, () => {
        logger.info('Starting scheduled job: Plex Watchlist Sync', {
          label: 'Jobs',
        });
        void runScheduledJobById('plex-watchlist-sync');
      }),
    });
  } else if (
    mediaServerType === MediaServerType.JELLYFIN ||
    mediaServerType === MediaServerType.EMBY
  ) {
    // Run recently added jellyfin sync every 5 minutes
    scheduledJobs.push({
      id: 'jellyfin-recently-added-scan',
      name: 'Jellyfin Recently Added Scan',
      type: 'process',
      interval: 'minutes',
      cronSchedule: jobs['jellyfin-recently-added-scan'].schedule,
      job: schedule.scheduleJob(
        jobs['jellyfin-recently-added-scan'].schedule,
        () => {
          logger.info('Starting scheduled job: Jellyfin Recently Added Scan', {
            label: 'Jobs',
          });
          void runScheduledJobById('jellyfin-recently-added-scan');
        }
      ),
      running: () => jellyfinRecentScanner.status().running,
      cancelFn: () => jellyfinRecentScanner.cancel(),
    });

    // Run full jellyfin sync every 24 hours
    scheduledJobs.push({
      id: 'jellyfin-full-scan',
      name: 'Jellyfin Full Library Scan',
      type: 'process',
      interval: 'hours',
      cronSchedule: jobs['jellyfin-full-scan'].schedule,
      job: schedule.scheduleJob(jobs['jellyfin-full-scan'].schedule, () => {
        logger.info('Starting scheduled job: Jellyfin Full Scan', {
          label: 'Jobs',
        });
        void runScheduledJobById('jellyfin-full-scan');
      }),
      running: () => jellyfinFullScanner.status().running,
      cancelFn: () => jellyfinFullScanner.cancel(),
    });
  }

  // Run Radarr scan every 15 minutes so imported files become Available
  // without waiting for the daily Jellyfin full library scan.
  scheduledJobs.push({
    id: 'radarr-scan',
    name: 'Radarr Scan',
    type: 'process',
    interval: 'minutes',
    cronSchedule: jobs['radarr-scan'].schedule,
    job: schedule.scheduleJob(jobs['radarr-scan'].schedule, () => {
      logger.info('Starting scheduled job: Radarr Scan', { label: 'Jobs' });
      void runScheduledJobById('radarr-scan');
    }),
    running: () => radarrScanner.status().running,
    cancelFn: () => radarrScanner.cancel(),
  });

  scheduledJobs.push({
    id: 'episode-request-sync',
    name: 'Episode Request Sync',
    type: 'process',
    interval: 'minutes',
    cronSchedule: jobs['episode-request-sync'].schedule,
    job: schedule.scheduleJob(jobs['episode-request-sync'].schedule, () => {
      logger.info('Starting scheduled job: Episode Request Sync', {
        label: 'Jobs',
      });
      void runScheduledJobById('episode-request-sync');
    }),
    running: () => episodeRequestSync.running,
    cancelFn: () => episodeRequestSync.cancel(),
  });

  scheduledJobs.push({
    id: 'release-calendar-sync',
    name: 'Release Calendar Sync',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['release-calendar-sync'].schedule,
    job: schedule.scheduleJob(jobs['release-calendar-sync'].schedule, () => {
      logger.info('Starting scheduled job: Release Calendar Sync', {
        label: 'Jobs',
      });
      void runScheduledJobById('release-calendar-sync');
    }),
    running: () => releaseCalendarSync.running,
    cancelFn: () => releaseCalendarSync.cancel(),
  });

  scheduledJobs.push({
    id: 'sonarr-scan',
    name: 'Sonarr Scan',
    type: 'process',
    interval: 'minutes',
    cronSchedule: jobs['sonarr-scan'].schedule,
    job: schedule.scheduleJob(jobs['sonarr-scan'].schedule, () => {
      logger.info('Starting scheduled job: Sonarr Scan', { label: 'Jobs' });
      void runScheduledJobById('sonarr-scan');
    }),
    running: () => sonarrScanner.status().running,
    cancelFn: () => sonarrScanner.cancel(),
  });

  // Checks if media is still available in plex/sonarr/radarr libs
  scheduledJobs.push({
    id: 'availability-sync',
    name: 'Media Availability Sync',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['availability-sync'].schedule,
    job: schedule.scheduleJob(jobs['availability-sync'].schedule, () => {
      logger.info('Starting scheduled job: Media Availability Sync', {
        label: 'Jobs',
      });
      void runScheduledJobById('availability-sync');
    }),
    running: () => availabilitySync.running,
    cancelFn: () => availabilitySync.cancel(),
  });

  // Run download sync every minute
  scheduledJobs.push({
    id: 'download-sync',
    name: 'Download Sync',
    type: 'command',
    interval: 'seconds',
    cronSchedule: jobs['download-sync'].schedule,
    job: schedule.scheduleJob(jobs['download-sync'].schedule, () => {
      logger.debug('Starting scheduled job: Download Sync', {
        label: 'Jobs',
      });
      void runScheduledJobById('download-sync');
    }),
  });

  // Reset download sync everyday at 01:00 am
  scheduledJobs.push({
    id: 'download-sync-reset',
    name: 'Download Sync Reset',
    type: 'command',
    interval: 'hours',
    cronSchedule: jobs['download-sync-reset'].schedule,
    job: schedule.scheduleJob(jobs['download-sync-reset'].schedule, () => {
      logger.info('Starting scheduled job: Download Sync Reset', {
        label: 'Jobs',
      });
      void runScheduledJobById('download-sync-reset');
    }),
  });

  // Run image cache cleanup every 24 hours
  scheduledJobs.push({
    id: 'image-cache-cleanup',
    name: 'Image Cache Cleanup',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['image-cache-cleanup'].schedule,
    job: schedule.scheduleJob(jobs['image-cache-cleanup'].schedule, () => {
      logger.info('Starting scheduled job: Image Cache Cleanup', {
        label: 'Jobs',
      });
      void runScheduledJobById('image-cache-cleanup');
    }),
  });

  scheduledJobs.push({
    id: 'process-blocklisted-tags',
    name: 'Process Blocklisted Tags',
    type: 'process',
    interval: 'days',
    cronSchedule: jobs['process-blocklisted-tags'].schedule,
    job: schedule.scheduleJob(jobs['process-blocklisted-tags'].schedule, () => {
      logger.info('Starting scheduled job: Process Blocklisted Tags', {
        label: 'Jobs',
      });
      void runScheduledJobById('process-blocklisted-tags');
    }),
    running: () => blocklistedTagsProcessor.status().running,
    cancelFn: () => blocklistedTagsProcessor.cancel(),
  });

  scheduledJobs.push({
    id: 'mapping-pack-refresh',
    name: 'Mapping Pack Refresh',
    type: 'process',
    interval: 'days',
    cronSchedule: jobs['mapping-pack-refresh'].schedule,
    job: schedule.scheduleJob(jobs['mapping-pack-refresh'].schedule, () => {
      logger.info('Starting scheduled job: Mapping Pack Refresh', {
        label: 'Jobs',
      });
      void runScheduledJobById('mapping-pack-refresh');
    }),
  });

  scheduledJobs.push({
    id: 'mapping-backfill',
    name: 'Mapping Gap Backfill',
    type: 'process',
    interval: 'days',
    cronSchedule: jobs['mapping-backfill'].schedule,
    job: schedule.scheduleJob(jobs['mapping-backfill'].schedule, () => {
      logger.info('Starting scheduled job: Mapping Gap Backfill', {
        label: 'Jobs',
      });
      void runScheduledJobById('mapping-backfill');
    }),
  });

  logger.info('Scheduled jobs loaded', { label: 'Jobs' });
};

/** Queue one coalesced desktop catch-up pass after the UI has settled. */
export const startDesktopCatchUp = (): void => {
  if (!isDesktopRuntime()) return;
  if (desktopCatchUpTimer) return;
  desktopCatchUpTimer = setTimeout(() => {
    desktopCatchUpTimer = undefined;
    void (async () => {
      const repository = getRepository(JobExecutionState);
      // Download tracking intentionally does not replay cron history. Each
      // desktop launch resets stale tracker state and performs one fresh poll,
      // then the ordinary schedule resumes.
      if (!desktopDownloadStartupRun) {
        desktopDownloadStartupRun = true;
        await executeManagedJob('download-sync-reset', 'light', () =>
          downloadTracker.resetDownloadTracker()
        );
        await executeManagedJob('download-sync', 'light', () =>
          downloadTracker.updateDownloads()
        );
      }
      // A playback session may have deferred scheduled heavy work while the
      // timer was pending. Draining here guarantees a full 30 seconds of
      // desktop idleness after the final playback-active=false signal.
      await runDeferredHeavyJobs();
      for (const job of scheduledJobs) {
        // Download tracking and image cleanup have dedicated startup
        // maintenance semantics rather than missed-cron replay.
        if (
          job.id === 'download-sync-reset' ||
          job.id === 'download-sync' ||
          job.id === 'image-cache-cleanup'
        ) {
          continue;
        }
        const state = await repository.findOne({ where: { jobId: job.id } });
        const weight: ManagedJobWeight = heavyJobIds.has(job.id)
          ? 'heavy'
          : 'light';
        if (canRunLaunchCatchUp(job.cronSchedule, weight, state ?? {})) {
          logger.info(`Running desktop catch-up: ${job.name}`, {
            label: 'Jobs',
          });
          // The executor admits only one heavy and two light jobs. Awaiting
          // here prevents the remaining overdue jobs from being dropped.
          await runScheduledJobById(job.id);
        }
      }
    })().catch((error) => {
      logger.warn('Desktop catch-up evaluation failed', {
        label: 'Jobs',
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, 30_000);
};

export const stopJobs = (): void => {
  if (desktopCatchUpTimer) {
    clearTimeout(desktopCatchUpTimer);
    desktopCatchUpTimer = undefined;
  }
  desktopDownloadStartupRun = false;
  deferredHeavyJobs.clear();
  cancelManagedJobs();
  for (const scheduledJob of scheduledJobs) {
    scheduledJob.job.cancel();
    scheduledJob.cancelFn?.();
  }
  scheduledJobs.splice(0, scheduledJobs.length);
  logger.info('Scheduled jobs stopped', { label: 'Jobs' });
};
