import type {
  CalendarMediaType,
  CalendarScope,
  CalendarSource,
} from '@server/interfaces/api/calendarInterfaces';

export type CalendarView = 'month' | 'agenda';

export type CalendarFilterState = {
  scope: CalendarScope;
  mediaType: CalendarMediaType | '';
  source: CalendarSource | '';
  is4k: boolean;
};

export const calendarFilterStorageKey = 'foreseer.calendar.filters';

export const readCalendarFilters = (): CalendarFilterState => {
  const defaults: CalendarFilterState = {
    scope: 'mine',
    mediaType: '',
    source: '',
    is4k: false,
  };

  if (typeof window === 'undefined') return defaults;

  try {
    const stored = JSON.parse(
      window.localStorage.getItem(calendarFilterStorageKey) ?? '{}'
    ) as Partial<CalendarFilterState>;
    return {
      scope: stored.scope === 'all' ? 'all' : defaults.scope,
      mediaType:
        stored.mediaType === 'movie' || stored.mediaType === 'tv'
          ? stored.mediaType
          : defaults.mediaType,
      source:
        stored.source === 'radarr' || stored.source === 'sonarr'
          ? stored.source
          : defaults.source,
      is4k: stored.is4k === true,
    };
  } catch {
    return defaults;
  }
};

export const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());

export const addDays = (date: Date, days: number) => {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
};

export const toLocalDate = (value: string, allDay = false) => {
  if (allDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T12:00:00`);
  }
  return new Date(value);
};

export const sameDay = (left: Date, right: Date) =>
  left.getFullYear() === right.getFullYear() &&
  left.getMonth() === right.getMonth() &&
  left.getDate() === right.getDate();

export const calendarRange = (date: Date, view: CalendarView) => {
  if (view === 'agenda') {
    return { start: startOfDay(date), end: addDays(startOfDay(date), 45) };
  }
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const start = addDays(first, -first.getDay());
  return { start, end: addDays(start, 42) };
};
