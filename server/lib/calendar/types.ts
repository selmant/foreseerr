import type {
  CalendarMediaType,
  CalendarScope,
  CalendarSource,
} from '@server/interfaces/api/calendarInterfaces';

export interface CalendarFilters {
  start: Date;
  end: Date;
  scope: CalendarScope;
  mediaType?: CalendarMediaType;
  source?: CalendarSource;
  serverId?: number;
  is4k?: boolean;
  includeEpisodes: boolean;
  includeUnmonitored: boolean;
}

export interface CalendarRequestContext {
  userId?: number;
  isAdmin: boolean;
}
