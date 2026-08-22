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
]);
let desktopCatchUpTimer: NodeJS.Timeout | undefined;
let desktopDownloadStartupRun = false;

const runScheduledJob = (
  id: string,
  weight: ManagedJobWeight,
  name: string,
  run: () => Promise<unknown>
): void => {
  if (weight === 'heavy' && isDesktopPlaybackActive()) {
    logger.info(
      `Deferring heavy job while desktop playback is active: ${name}`,
      {
        label: 'Jobs',
      }
    );
    return;
  }
  void executeManagedJob(id, weight, () => run()).catch((error) => {
    logger.error(`Failed to record scheduled job: ${name}`, {
      label: 'Jobs',
      message: error instanceof Error ? error.message : String(error),
    });
  });
};

const runHeavy = (id: string, name: string, run: () => Promise<unknown>) =>
  runScheduledJob(id, 'heavy', name, run);

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
          runHeavy('plex-recently-added-scan', 'Plex Recently Added Scan', () =>
            plexRecentScanner.run()
          );
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
        runHeavy('plex-full-scan', 'Plex Full Library Scan', () =>
          plexFullScanner.run()
        );
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
        runScheduledJob(
          'plex-refresh-token',
          'light',
          'Plex Refresh Token',
          () => refreshToken.run()
        );
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
        runScheduledJob(
          'plex-watchlist-sync',
          'light',
          'Plex Watchlist Sync',
          () => watchlistSync.syncWatchlist()
        );
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
          runHeavy(
            'jellyfin-recently-added-scan',
            'Jellyfin Recently Added Scan',
            () => jellyfinRecentScanner.run()
          );
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
        runHeavy('jellyfin-full-scan', 'Jellyfin Full Scan', () =>
          jellyfinFullScanner.run()
        );
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
      runHeavy('radarr-scan', 'Radarr Scan', () => radarrScanner.run());
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
      runScheduledJob(
        'episode-request-sync',
        'light',
        'Episode Request Sync',
        () => episodeRequestSync.run()
      );
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
      runScheduledJob(
        'release-calendar-sync',
        'light',
        'Release Calendar Sync',
        () => releaseCalendarSync.run()
      );
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
      runHeavy('sonarr-scan', 'Sonarr Scan', () => sonarrScanner.run());
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
      runHeavy('availability-sync', 'Media Availability Sync', () =>
        availabilitySync.run()
      );
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
      runScheduledJob('download-sync', 'light', 'Download Sync', () =>
        downloadTracker.updateDownloads()
      );
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
      runScheduledJob(
        'download-sync-reset',
        'light',
        'Download Sync Reset',
        () => downloadTracker.resetDownloadTracker()
      );
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
      // Clean TMDB image cache
      runScheduledJob(
        'image-cache-cleanup',
        'light',
        'Image Cache Cleanup',
        async () => {
          ImageProxy.clearCache('tmdb');
          ImageProxy.clearCache('avatar');
          await ImageProxy.maintainCache();
        }
      );
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
      runHeavy('process-blocklisted-tags', 'Process Blocklisted Tags', () =>
        blocklistedTagsProcessor.run()
      );
    }),
    running: () => blocklistedTagsProcessor.status().running,
    cancelFn: () => blocklistedTagsProcessor.cancel(),
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
          job.job.invoke();
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
  cancelManagedJobs();
  for (const scheduledJob of scheduledJobs) {
    scheduledJob.job.cancel();
    scheduledJob.cancelFn?.();
  }
  scheduledJobs.splice(0, scheduledJobs.length);
  logger.info('Scheduled jobs stopped', { label: 'Jobs' });
};
