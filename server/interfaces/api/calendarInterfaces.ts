export type CalendarScope = 'mine' | 'all';
export type CalendarMediaType = 'movie' | 'tv';
export type CalendarSource = 'sonarr' | 'radarr';
export type CalendarDateType = 'air' | 'digital' | 'physical' | 'theatrical';

export interface CalendarDate {
  dateType: CalendarDateType;
  startsAt: string;
  allDay: boolean;
}

export interface CalendarItem {
  id: string | number;
  mediaType: CalendarMediaType;
  source: CalendarSource;
  title: string;
  subtitle?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  startsAt: string;
  allDay: boolean;
  dateType: CalendarDateType;
  posterPath?: string | null;
  detailUrl?: string | null;
  sourceUrl?: string | null;
  watchUrl?: string | null;
  requestedByCurrentUser: boolean;
  requestStatus?:
    | 'pending'
    | 'approved'
    | 'processing'
    | 'available'
    | string
    | null;
  requestedQuality?: '4k' | 'standard' | string | null;
  available: boolean;
  monitored?: boolean;
  is4k?: boolean;
  changeKind?: 'announced' | 'moved_earlier' | 'delayed' | 'withdrawn' | null;
  previousStartsAt?: string | null;
  isNewSeason?: boolean;
  dates?: CalendarDate[];
}

export interface CalendarPartialSource {
  id?: number;
  name: string;
  lastSuccessfulSync?: string | null;
}

export interface CalendarResponse {
  results: CalendarItem[];
  partialSources?: CalendarPartialSource[];
  lastSuccessfulSync?: string | null;
}
