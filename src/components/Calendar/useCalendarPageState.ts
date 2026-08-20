import {
  addDays,
  calendarFilterStorageKey,
  calendarRange,
  readCalendarFilters,
  startOfDay,
  type CalendarView,
} from '@app/components/Calendar/calendarUtils';
import useCalendar from '@app/hooks/useCalendar';
import type {
  CalendarMediaType,
  CalendarScope,
  CalendarSource,
} from '@server/interfaces/api/calendarInterfaces';
import { useEffect, useMemo, useState } from 'react';

export function useCalendarPageState() {
  const initialFilters = useMemo(readCalendarFilters, []);
  const [view, setView] = useState<CalendarView>('month');
  const [anchorDate, setAnchorDate] = useState(() => startOfDay(new Date()));
  const [scope, setScope] = useState<CalendarScope>(initialFilters.scope);
  const [mediaType, setMediaType] = useState<CalendarMediaType | ''>(
    initialFilters.mediaType
  );
  const [source, setSource] = useState<CalendarSource | ''>(
    initialFilters.source
  );
  const [is4k, setIs4k] = useState(initialFilters.is4k);

  useEffect(() => {
    if (window.matchMedia('(max-width: 1023px)').matches) setView('agenda');
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      calendarFilterStorageKey,
      JSON.stringify({ scope, mediaType, source, is4k })
    );
  }, [scope, mediaType, source, is4k]);

  const range = useMemo(
    () => calendarRange(anchorDate, view),
    [anchorDate, view]
  );
  const calendar = useCalendar({
    start: range.start,
    end: range.end,
    scope,
    mediaType: mediaType || undefined,
    source: source || undefined,
    is4k,
    includeEpisodes: true,
  });
  const movePeriod = (direction: number) => {
    setAnchorDate((date) =>
      view === 'month'
        ? new Date(date.getFullYear(), date.getMonth() + direction, 1)
        : addDays(date, direction * 45)
    );
  };

  return {
    ...calendar,
    anchorDate,
    filters: { scope, mediaType, source, is4k },
    movePeriod,
    range,
    setAnchorDate,
    setFilters: { setScope, setMediaType, setSource, setIs4k },
    setView,
    view,
  };
}
