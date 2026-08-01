import type {
  ReleaseDateType,
  ReleaseSource,
} from '@server/entity/ReleaseOccurrence';

export interface NormalizedOccurrence {
  source: ReleaseSource;
  sourceServerId: number;
  sourceItemId: number;
  sourceSeriesId?: number;
  sourceSeriesTvdbId?: number;
  mediaType: 'movie' | 'tv';
  tmdbId?: number;
  tvdbId?: number;
  title: string;
  subtitle?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  dateType: ReleaseDateType;
  startsAt: Date;
  allDay: boolean;
  monitored: boolean;
  hasFile: boolean;
  is4k: boolean;
  sourceUrl?: string;
  rawDates: string;
}

export interface ReleaseCalendarSyncResult {
  fetched: number;
  inserted: number;
  changed: number;
  missing: number;
  unmapped: number;
  errored: number;
}

export interface ReleaseCalendarSourceStatus {
  source: ReleaseSource;
  serverId: number;
  lastSuccessAt?: Date;
  lastErrorAt?: Date;
  error?: string;
}

export const emptySyncResult = (): ReleaseCalendarSyncResult => ({
  fetched: 0,
  inserted: 0,
  changed: 0,
  missing: 0,
  unmapped: 0,
  errored: 0,
});
