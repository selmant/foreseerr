import TheMovieDb from '@server/api/themoviedb';
import type { CalendarItem } from '@server/interfaces/api/calendarInterfaces';
import { mapWithConcurrency } from '@server/lib/concurrency';
import { getReleaseRelevanceMap } from '@server/lib/releases/relevance';
import logger from '@server/logger';
import { collectMovieDates, mapCalendarOccurrence } from './mapper';
import {
  findCalendarJoinData,
  findCalendarOccurrences,
  selectPrimaryRadarrDates,
} from './repository';
import type { CalendarFilters, CalendarRequestContext } from './types';

export async function getCalendarItems(
  filters: CalendarFilters,
  context: CalendarRequestContext
): Promise<CalendarItem[]> {
  const allOccurrences = await findCalendarOccurrences(filters);
  const movieDates = collectMovieDates(allOccurrences);
  const occurrences = selectPrimaryRadarrDates(allOccurrences, 'digital');
  const [{ latestChanges, mediaById }, relevanceByOccurrence] =
    await Promise.all([
      findCalendarJoinData(occurrences),
      getReleaseRelevanceMap(occurrences),
    ]);
  const items = occurrences.flatMap((occurrence) => {
    const relevance = relevanceByOccurrence.get(occurrence.id) ?? [];
    if (
      filters.scope === 'mine' &&
      !relevance.some((item) => item.userId === context.userId)
    ) {
      return [];
    }
    const item = mapCalendarOccurrence(occurrence, movieDates, {
      ...context,
      latestChanges,
      mediaById,
      relevanceByOccurrence,
    });
    return item ? [item] : [];
  });
  return attachPosters(items);
}

/** Release sources carry no artwork; borrow posters from cached TMDB metadata. */
async function attachPosters(items: CalendarItem[]): Promise<CalendarItem[]> {
  const keys = [
    ...new Set(
      items.flatMap((item) =>
        item.tmdbId ? [`${item.mediaType}:${item.tmdbId}`] : []
      )
    ),
  ];
  if (!keys.length) {
    return items;
  }

  const tmdb = new TheMovieDb();
  const posters = new Map<string, string | null>();
  await mapWithConcurrency(keys, 8, async (key) => {
    const [mediaType, id] = key.split(':');
    try {
      const metadata =
        mediaType === 'movie'
          ? await tmdb.getMovieBrowseMetadata({ movieId: Number(id) })
          : await tmdb.getTvBrowseMetadata({ tvId: Number(id) });
      posters.set(key, metadata.poster_path);
    } catch (e) {
      logger.debug('Unable to load calendar poster', {
        label: 'Calendar',
        key,
        errorMessage: e.message,
      });
    }
  });

  return items.map((item) => {
    const posterPath = item.tmdbId
      ? posters.get(`${item.mediaType}:${item.tmdbId}`)
      : undefined;
    return posterPath ? { ...item, posterPath } : item;
  });
}
