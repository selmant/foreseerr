import type { RadarrMovie } from '@server/api/servarr/radarr';
import type { SonarrCalendarEpisode } from '@server/api/servarr/sonarr';
import type ReleaseOccurrence from '@server/entity/ReleaseOccurrence';
import type { ReleaseDateType } from '@server/entity/ReleaseOccurrence';
import type { DVRSettings } from '@server/lib/settings';
import type { NormalizedOccurrence } from './types';

const ALL_DAY_CHANGE_HOURS = 24;
const TIMED_CHANGE_HOURS = 12;

export const occurrenceKey = (
  occurrence: Pick<NormalizedOccurrence, 'sourceItemId' | 'dateType'>
) => `${occurrence.sourceItemId}:${occurrence.dateType}`;

export const parseProviderDate = (value?: string) => {
  if (!value) return undefined;
  const startsAt = new Date(value);
  if (Number.isNaN(startsAt.getTime())) return undefined;
  return { startsAt, allDay: /^\d{4}-\d{2}-\d{2}$/.test(value) };
};

const sourceUrl = (server: DVRSettings, path: string) => {
  const base =
    server.externalUrl ??
    `${server.useSsl ? 'https' : 'http'}://${server.hostname}:${server.port}${server.baseUrl ?? ''}`;
  try {
    return new URL(
      path.replace(/^\//, ''),
      `${base.replace(/\/$/, '')}/`
    ).toString();
  } catch {
    return undefined;
  }
};

export const isMaterialDateChange = (
  existing: Pick<ReleaseOccurrence, 'startsAt' | 'allDay'>,
  next: Pick<NormalizedOccurrence, 'startsAt' | 'allDay'>
) => {
  const thresholdHours =
    existing.allDay || next.allDay ? ALL_DAY_CHANGE_HOURS : TIMED_CHANGE_HOURS;
  return (
    Math.abs(existing.startsAt.getTime() - next.startsAt.getTime()) >=
    thresholdHours * 60 * 60 * 1000
  );
};

export const normalizeRadarrMovie = (
  movie: RadarrMovie,
  server: DVRSettings
): NormalizedOccurrence[] => {
  const rawDates = JSON.stringify({
    inCinemas: movie.inCinemas,
    digitalRelease: movie.digitalRelease,
    physicalRelease: movie.physicalRelease,
  });
  const dates: [ReleaseDateType, string | undefined][] = [
    ['digital', movie.digitalRelease],
    ['physical', movie.physicalRelease],
    ['theatrical', movie.inCinemas],
  ];

  return dates.flatMap(([dateType, value]) => {
    const parsed = parseProviderDate(value);
    if (!parsed) return [];
    return [
      {
        source: 'radarr',
        sourceServerId: server.id,
        sourceItemId: movie.id,
        mediaType: 'movie',
        tmdbId: movie.tmdbId,
        title: movie.title,
        dateType,
        ...parsed,
        monitored: movie.monitored,
        hasFile: movie.hasFile || movie.isAvailable,
        is4k: server.is4k,
        sourceUrl: sourceUrl(server, `/movie/${movie.titleSlug || movie.id}`),
        rawDates,
      },
    ];
  });
};

export const normalizeSonarrEpisode = (
  episode: SonarrCalendarEpisode,
  server: DVRSettings
): NormalizedOccurrence[] => {
  const parsed = parseProviderDate(episode.airDateUtc || episode.airDate);
  if (!parsed) return [];

  return [
    {
      source: 'sonarr',
      sourceServerId: server.id,
      sourceItemId: episode.id,
      sourceSeriesId: episode.seriesId,
      sourceSeriesTvdbId: episode.series?.tvdbId,
      mediaType: 'tv',
      tvdbId: episode.tvdbId,
      title: episode.series?.title ?? 'Unknown series',
      subtitle: episode.title,
      seasonNumber: episode.seasonNumber,
      episodeNumber: episode.episodeNumber,
      dateType: 'air',
      ...parsed,
      monitored: episode.monitored && (episode.series?.monitored ?? true),
      hasFile: episode.hasFile,
      is4k: server.is4k,
      sourceUrl: sourceUrl(
        server,
        `/series/${episode.series?.titleSlug || episode.seriesId}`
      ),
      rawDates: JSON.stringify({
        airDate: episode.airDate,
        airDateUtc: episode.airDateUtc,
      }),
    },
  ];
};
