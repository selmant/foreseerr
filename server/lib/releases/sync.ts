import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import type { ReleaseSource } from '@server/entity/ReleaseOccurrence';
import type ReleaseSyncState from '@server/entity/ReleaseSyncState';
import type { DVRSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { normalizeRadarrMovie, normalizeSonarrEpisode } from './normalization';
import { safelyProduceReleaseEvents } from './producers';
import {
  reconcileServerOccurrences,
  type DiscoveredReleaseEvents,
} from './repository';
import {
  RELEASE_SYNC_LEASE_MS,
  acquireReleaseSyncLease,
  assertReleaseSyncLease,
  getReleaseSyncState,
  markReleaseSyncError,
  markReleaseSyncSuccess,
  releaseReleaseSyncLease,
  renewReleaseSyncLease,
  type ReleaseSyncLease,
  type ReleaseSyncLeaseRequest,
  type ReleaseSyncMode,
} from './state';
import {
  emptySyncResult,
  type NormalizedOccurrence,
  type ReleaseCalendarSourceStatus,
  type ReleaseCalendarSyncResult,
} from './types';

export { isMaterialDateChange, parseProviderDate } from './normalization';
export type {
  ReleaseCalendarSourceStatus,
  ReleaseCalendarSyncResult,
} from './types';

const INCREMENTAL_PAST_DAYS = 7;
const INCREMENTAL_FUTURE_DAYS = 45;
const BACKFILL_PAST_DAYS = 30;
const BACKFILL_FUTURE_DAYS = 365;
const BACKFILL_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const calendarWindow = (mode: ReleaseSyncMode, now = new Date()) => {
  const start = new Date(now);
  const end = new Date(now);
  const pastDays =
    mode === 'backfill' ? BACKFILL_PAST_DAYS : INCREMENTAL_PAST_DAYS;
  const futureDays =
    mode === 'backfill' ? BACKFILL_FUTURE_DAYS : INCREMENTAL_FUTURE_DAYS;
  start.setUTCDate(start.getUTCDate() - pastDays);
  end.setUTCDate(end.getUTCDate() + futureDays);
  return { start, end };
};

export const releaseSyncMode = (
  state: Pick<ReleaseSyncState, 'lastSuccessfulBackfillAt'>,
  now = new Date()
): ReleaseSyncMode =>
  !state.lastSuccessfulBackfillAt ||
  now.getTime() - state.lastSuccessfulBackfillAt.getTime() >=
    BACKFILL_INTERVAL_MS
    ? 'backfill'
    : 'incremental';

/**
 * External notifications are not transactional, so renew and fence-check at
 * the handoff. A replica that lost its lease never starts notification I/O.
 */
export const produceReleaseEventsWithLease = async (
  lease: ReleaseSyncLease,
  events: DiscoveredReleaseEvents,
  produce: (
    events: DiscoveredReleaseEvents
  ) => Promise<void> = safelyProduceReleaseEvents
): Promise<void> => {
  if (!(await renewReleaseSyncLease(lease))) {
    throw new Error(
      'Release calendar sync lease was lost before notifications'
    );
  }
  await assertReleaseSyncLease(lease);
  await produce(events);
};

class ReleaseCalendarSync {
  public running = false;
  private cancelled = false;
  private sourceStatuses = new Map<string, ReleaseCalendarSourceStatus>();

  public cancel(): void {
    this.cancelled = true;
  }

  public getSourceStatuses(): ReleaseCalendarSourceStatus[] {
    return [...this.sourceStatuses.values()];
  }

  public async run(): Promise<ReleaseCalendarSyncResult | undefined> {
    if (this.running) return undefined;

    this.running = true;
    this.cancelled = false;
    const result = emptySyncResult();
    const settings = getSettings();
    const sources = [
      ...settings.radarr.map((server) => ({
        source: 'radarr' as const,
        server,
      })),
      ...settings.sonarr.map((server) => ({
        source: 'sonarr' as const,
        server,
      })),
    ];

    try {
      for (const { source, server } of sources) {
        if (this.cancelled) break;
        await this.syncServer(source, server, result);
      }
      logger.info('Release calendar sync finished', {
        label: 'Release Calendar Sync',
        ...result,
        cancelled: this.cancelled,
      });
      return result;
    } finally {
      this.running = false;
      this.cancelled = false;
    }
  }

  private async fetchOccurrences(
    source: ReleaseSource,
    server: DVRSettings,
    start: Date,
    end: Date
  ): Promise<NormalizedOccurrence[]> {
    if (source === 'radarr') {
      const api = new RadarrAPI({
        apiKey: server.apiKey,
        url: RadarrAPI.buildUrl(server, '/api/v3'),
      });
      return (await api.getCalendar(start, end)).flatMap((movie) =>
        normalizeRadarrMovie(movie, server)
      );
    }

    const api = new SonarrAPI({
      apiKey: server.apiKey,
      url: SonarrAPI.buildUrl(server, '/api/v3'),
    });
    return (await api.getCalendar(start, end)).flatMap((episode) =>
      normalizeSonarrEpisode(episode, server)
    );
  }

  private async syncServer(
    source: ReleaseSource,
    server: DVRSettings,
    result: ReleaseCalendarSyncResult
  ): Promise<void> {
    const statusKey = `${source}:${server.id}`;
    const request: ReleaseSyncLeaseRequest = {
      source,
      sourceServerId: server.id,
      owner: `${process.pid}:${crypto.randomUUID()}`,
    };
    let timer: NodeJS.Timeout | undefined;
    let renewal = Promise.resolve(true);
    let lease: ReleaseSyncLease | undefined;

    try {
      lease = await acquireReleaseSyncLease(request);
      if (!lease) {
        logger.debug('Release calendar sync skipped; source lease is held', {
          label: 'Release Calendar Sync',
          source,
          serverId: server.id,
        });
        return;
      }
      const activeLease = lease;
      const state = await getReleaseSyncState(source, server.id);
      const mode = releaseSyncMode(state);
      timer = setInterval(() => {
        renewal = renewal
          .then(() => renewReleaseSyncLease(activeLease))
          .catch(() => false);
      }, RELEASE_SYNC_LEASE_MS / 3);
      const { start, end } = calendarWindow(mode);
      const occurrences = await this.fetchOccurrences(
        source,
        server,
        start,
        end
      );
      if (!(await renewal) || !(await renewReleaseSyncLease(activeLease))) {
        throw new Error(
          'Release calendar sync lease was lost before reconcile'
        );
      }
      result.fetched += occurrences.length;
      const events = await reconcileServerOccurrences({
        source,
        sourceServerId: server.id,
        occurrences,
        start,
        end,
        result,
        initialBackfill: mode === 'backfill' && !state.lastSuccessfulBackfillAt,
        lease: activeLease,
      });
      await produceReleaseEventsWithLease(activeLease, events);
      await markReleaseSyncSuccess(activeLease, mode);
      this.sourceStatuses.set(statusKey, {
        source,
        serverId: server.id,
        lastSuccessAt: new Date(),
        ...(mode === 'backfill' ? { lastBackfillAt: new Date() } : {}),
      });
    } catch (error) {
      result.errored += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (lease) {
        await markReleaseSyncError(lease, message);
      }
      this.sourceStatuses.set(statusKey, {
        source,
        serverId: server.id,
        lastErrorAt: new Date(),
        error: message,
      });
      logger.warn(`Release calendar sync failed for ${source} server`, {
        label: 'Release Calendar Sync',
        source,
        serverId: server.id,
        serverName: server.name,
        endpoint: '/calendar',
        errorMessage: message,
      });
    } finally {
      if (timer) clearInterval(timer);
      if (lease) await releaseReleaseSyncLease(lease);
    }
  }
}

export default new ReleaseCalendarSync();
