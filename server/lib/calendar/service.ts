import type { CalendarItem } from '@server/interfaces/api/calendarInterfaces';
import { getReleaseRelevanceMap } from '@server/lib/releases/relevance';
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
  return occurrences.flatMap((occurrence) => {
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
}
