import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import type { ReleaseSource } from '@server/entity/ReleaseOccurrence';
import type { DVRSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { normalizeRadarrMovie, normalizeSonarrEpisode } from './normalization';
import { safelyProduceReleaseEvents } from './producers';
import { reconcileServerOccurrences } from './repository';
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

const PAST_DAYS = 30;
const FUTURE_DAYS = 365;

const calendarWindow = () => {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - PAST_DAYS);
  const end = new Date();
  end.setUTCDate(end.getUTCDate() + FUTURE_DAYS);
  return { start, end };
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
    const { start, end } = calendarWindow();
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
        await this.syncServer(source, server, start, end, result);
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
    start: Date,
    end: Date,
    result: ReleaseCalendarSyncResult
  ): Promise<void> {
    const statusKey = `${source}:${server.id}`;
    try {
      const occurrences = await this.fetchOccurrences(
        source,
        server,
        start,
        end
      );
      result.fetched += occurrences.length;
      const events = await reconcileServerOccurrences({
        source,
        sourceServerId: server.id,
        occurrences,
        start,
        end,
        result,
      });
      await safelyProduceReleaseEvents(events);
      this.sourceStatuses.set(statusKey, {
        source,
        serverId: server.id,
        lastSuccessAt: new Date(),
      });
    } catch (error) {
      result.errored += 1;
      const message = error instanceof Error ? error.message : String(error);
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
    }
  }
}

export default new ReleaseCalendarSync();
