import type { CalendarFilters } from './types';

const MAX_RANGE_DAYS = 366;

const readSingle = (value: unknown) =>
  typeof value === 'string' ? value : undefined;
const parseBoolean = (value: unknown) =>
  value === 'true' ? true : value === 'false' ? false : undefined;

export function parseCalendarRange(query: Record<string, unknown>) {
  const startValue = readSingle(query.start);
  const endValue = readSingle(query.end);
  if (!startValue || !endValue) {
    throw new Error('start and end are required ISO dates or timestamps.');
  }
  const start = new Date(startValue);
  const end = new Date(endValue);
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    end <= start
  ) {
    throw new Error('start and end must define a valid, non-empty range.');
  }
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * 86400000) {
    throw new Error(`Calendar range cannot exceed ${MAX_RANGE_DAYS} days.`);
  }
  return { start, end };
}

export function parseCalendarQuery(
  query: Record<string, unknown>,
  isAdmin: boolean
): CalendarFilters {
  const { start, end } = parseCalendarRange(query);
  const scope = readSingle(query.scope) ?? 'mine';
  const mediaType = readSingle(query.mediaType);
  const source = readSingle(query.source);
  const serverId = readSingle(query.serverId);
  const is4k = parseBoolean(readSingle(query.is4k));
  const includeEpisodes =
    parseBoolean(readSingle(query.includeEpisodes)) ?? true;
  const includeUnmonitored =
    parseBoolean(readSingle(query.includeUnmonitored)) ?? false;
  if (scope !== 'mine' && scope !== 'all') {
    throw new Error('scope must be mine or all.');
  }
  if (mediaType && mediaType !== 'movie' && mediaType !== 'tv') {
    throw new Error('mediaType must be movie or tv.');
  }
  if (source && source !== 'sonarr' && source !== 'radarr') {
    throw new Error('source must be sonarr or radarr.');
  }
  if ((!isAdmin && serverId) || (!isAdmin && includeUnmonitored)) {
    const error = new Error(
      'This calendar filter requires administrator permission.'
    );
    Object.assign(error, { status: 403 });
    throw error;
  }
  if (serverId && (!/^\d+$/.test(serverId) || Number(serverId) < 1)) {
    throw new Error('serverId must be a positive integer.');
  }
  return {
    start,
    end,
    scope,
    mediaType: mediaType as CalendarFilters['mediaType'],
    source: source as CalendarFilters['source'],
    serverId: serverId ? Number(serverId) : undefined,
    is4k,
    includeEpisodes,
    includeUnmonitored,
  };
}

export function safeExternalHttpUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}
