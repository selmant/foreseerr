import { toCalendarDateKey } from '@server/lib/releases/calendarDateKey';
import type { CalendarFilterState, CalendarView } from './calendarUtils';

export type CalendarPageState = CalendarFilterState & {
  view: CalendarView;
  anchorDate: Date;
};

/** Read a local day without shifting it across time zones or accepting rolled dates. */
export const calendarDateFromInput = (value: string): Date | undefined => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1000) return undefined;
  const date = new Date(year, month - 1, day);
  return toCalendarDateKey(date) === value ? date : undefined;
};

const choice = <T extends string>(
  value: string | null,
  options: readonly T[],
  fallback: T
): T => (options.includes(value as T) ? (value as T) : fallback);

export const parseCalendarPageState = (
  search: string,
  defaults: CalendarPageState
): CalendarPageState => {
  const params = new URLSearchParams(search);
  return {
    view: choice(params.get('view'), ['month', 'agenda'], defaults.view),
    anchorDate:
      calendarDateFromInput(params.get('date') ?? '') ?? defaults.anchorDate,
    scope: choice(params.get('scope'), ['mine', 'all'], defaults.scope),
    mediaType:
      params.get('mediaType') === 'all'
        ? ''
        : choice(params.get('mediaType'), ['movie', 'tv'], defaults.mediaType),
    source:
      params.get('source') === 'all'
        ? ''
        : choice(params.get('source'), ['radarr', 'sonarr'], defaults.source),
    is4k:
      params.get('is4k') === 'true'
        ? true
        : params.get('is4k') === 'false'
          ? false
          : defaults.is4k,
  };
};

export const serializeCalendarPageState = (
  state: CalendarPageState,
  search = ''
) => {
  const params = new URLSearchParams(search);
  params.set('view', state.view);
  params.set('date', toCalendarDateKey(state.anchorDate));
  params.set('scope', state.scope);
  params.set('mediaType', state.mediaType || 'all');
  params.set('source', state.source || 'all');
  params.set('is4k', String(state.is4k));
  return params;
};
