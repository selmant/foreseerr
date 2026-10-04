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
import { useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import {
  parseCalendarPageState,
  serializeCalendarPageState,
  type CalendarPageState,
} from './queryState';

export function useCalendarPageState() {
  const defaults = useMemo<CalendarPageState>(
    () => ({
      ...readCalendarFilters(),
      view:
        typeof window !== 'undefined' &&
        window.matchMedia('(max-width: 1023px)').matches
          ? 'agenda'
          : 'month',
      anchorDate: startOfDay(new Date()),
    }),
    []
  );
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.toString();
  const state = useMemo(
    () => parseCalendarPageState(search, defaults),
    [defaults, search]
  );
  const { view, anchorDate, scope, mediaType, source, is4k } = state;
  const updateState = (patch: Partial<CalendarPageState>) =>
    setSearchParams((current) =>
      serializeCalendarPageState(
        { ...parseCalendarPageState(current.toString(), defaults), ...patch },
        current.toString()
      )
    );

  useEffect(() => {
    const canonical = serializeCalendarPageState(state, search);
    if (canonical.toString() !== search)
      setSearchParams(canonical, { replace: true });
  }, [search, setSearchParams, state]);

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
    updateState({
      anchorDate:
        view === 'month'
          ? new Date(
              anchorDate.getFullYear(),
              anchorDate.getMonth() + direction,
              1
            )
          : addDays(anchorDate, direction * 45),
    });
  };

  return {
    ...calendar,
    anchorDate,
    filters: { scope, mediaType, source, is4k },
    movePeriod,
    range,
    resetFilters: () =>
      updateState({ scope: 'mine', mediaType: '', source: '', is4k: false }),
    setAnchorDate: (date: Date) =>
      updateState({ anchorDate: startOfDay(date) }),
    setFilters: {
      setScope: (value: CalendarScope) => updateState({ scope: value }),
      setMediaType: (value: CalendarMediaType | '') =>
        updateState({ mediaType: value }),
      setSource: (value: CalendarSource | '') => updateState({ source: value }),
      setIs4k: (value: boolean) => updateState({ is4k: value }),
    },
    setView: (value: CalendarView) => updateState({ view: value }),
    view,
  };
}
