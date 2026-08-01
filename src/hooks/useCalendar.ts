import type {
  CalendarMediaType,
  CalendarResponse,
  CalendarScope,
  CalendarSource,
} from '@server/interfaces/api/calendarInterfaces';
import useSWR from 'swr';

export interface CalendarQuery {
  start: Date;
  end: Date;
  scope: CalendarScope;
  mediaType?: CalendarMediaType;
  source?: CalendarSource;
  is4k?: boolean;
  includeEpisodes?: boolean;
}

const calendarKey = ({
  start,
  end,
  scope,
  mediaType,
  source,
  is4k,
  includeEpisodes = true,
}: CalendarQuery) => {
  const parameters = new URLSearchParams({
    start: start.toISOString(),
    end: end.toISOString(),
    scope,
    includeEpisodes: String(includeEpisodes),
  });

  if (mediaType) parameters.set('mediaType', mediaType);
  if (source) parameters.set('source', source);
  if (is4k) parameters.set('is4k', 'true');

  return `/api/v1/calendar?${parameters.toString()}`;
};

const useCalendar = (query: CalendarQuery) =>
  useSWR<CalendarResponse>(calendarKey(query), { keepPreviousData: true });

export default useCalendar;
