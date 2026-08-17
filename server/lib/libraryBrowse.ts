import type { JellyfinLibraryItemExtended } from '@server/api/jellyfin';
import type { LibraryTitle } from '@server/interfaces/api/libraryInterfaces';
import type { ParsedLibraryBrowseQuery } from '@server/lib/libraryBrowseQuery';

const SORT_BY: Record<ParsedLibraryBrowseQuery['sort'], string> = {
  dateAdded: 'DateCreated',
  title: 'SortName',
  premiereDate: 'PremiereDate',
  lastPlayed: 'DatePlayed',
};

const WATCHED_FILTER: Record<
  NonNullable<ParsedLibraryBrowseQuery['watched']>,
  string
> = {
  unwatched: 'IsUnplayed',
  inProgress: 'IsResumable',
  played: 'IsPlayed',
};

/** Match displayed ProductionYear, not premiere-date year. */
export const productionYearsFilter = (
  yearFrom?: number,
  yearTo?: number
): string | undefined => {
  if (yearFrom == null && yearTo == null) {
    return undefined;
  }
  const rawStart = yearFrom ?? 1900;
  const rawEnd = yearTo ?? new Date().getUTCFullYear() + 1;
  const start = Math.min(rawStart, rawEnd);
  const end = Math.max(rawStart, rawEnd);
  const years: number[] = [];
  for (let year = start; year <= end; year += 1) {
    years.push(year);
  }
  return years.join(',');
};

export const uniqueSortedGenres = (
  names: (string | undefined | null)[]
): string[] => {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of names) {
    const name = raw?.trim();
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(name);
  }
  return unique.sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  );
};

export const BROWSE_ITEM_FIELDS =
  'ProviderIds,Overview,Genres,ProductionYear,DateCreated,PremiereDate,RunTimeTicks';

export const buildJellyfinBrowseParams = (
  query: ParsedLibraryBrowseQuery,
  userId: string
): Record<string, string | number | boolean> => {
  const include =
    query.mediaType === 'movie'
      ? 'Movie'
      : query.mediaType === 'tv'
        ? 'Series'
        : 'Movie,Series';

  const params: Record<string, string | number | boolean> = {
    userId,
    IncludeItemTypes: include,
    Recursive: true,
    EnableUserData: true,
    SortBy: SORT_BY[query.sort],
    SortOrder: query.order === 'asc' ? 'Ascending' : 'Descending',
    StartIndex: query.skip,
    Limit: query.take,
    Fields: BROWSE_ITEM_FIELDS,
  };

  if (query.q) {
    params.SearchTerm = query.q;
  }
  if (query.watched) {
    params.Filters = WATCHED_FILTER[query.watched];
  }
  if (query.genre?.length) {
    // Jellyfin `/Items` Genres is a comma-separated list. Multiple values
    // are OR'd by the server (same as the native library UI).
    params.Genres = query.genre.join(',');
  }
  const years = productionYearsFilter(query.yearFrom, query.yearTo);
  if (years) {
    params.Years = years;
  }

  return params;
};

export const JELLYFIN_ITEM_ID_PATTERN = /^[a-f0-9]{32}$/i;

export const isJellyfinItemId = (value: string): boolean =>
  JELLYFIN_ITEM_ID_PATTERN.test(value);

export const jellyfinItemImageRequest = (
  jellyfinItemId: string,
  imageType: 'primary' | 'backdrop'
): { path: string; params: { maxWidth: number; quality: number } } => {
  const image = imageType === 'primary' ? 'Primary' : 'Backdrop';
  return {
    path: `/Items/${jellyfinItemId}/Images/${image}`,
    params: {
      maxWidth: imageType === 'primary' ? 400 : 1280,
      quality: 90,
    },
  };
};

export const libraryItemImageUrl = (
  jellyfinItemId: string,
  imageType: 'primary' | 'backdrop'
): string => `/api/v1/library/items/${jellyfinItemId}/images/${imageType}`;

export const runtimeMinutesFromTicks = (ticks?: number): number | undefined => {
  if (!ticks || ticks <= 0) {
    return undefined;
  }
  return Math.max(1, Math.round(ticks / 10_000_000 / 60));
};

export const libraryTitleDisplayFields = (item: {
  Id: string;
  Type?: string;
  SeriesId?: string;
  ProductionYear?: number;
  Genres?: string[];
  DateCreated?: string;
  RunTimeTicks?: number;
  BackdropImageTags?: string[];
  UserData?: {
    Played?: boolean;
    PlayedPercentage?: number;
    PlaybackPositionTicks?: number;
    LastPlayedDate?: string;
    RunTimeTicks?: number;
    UnplayedItemCount?: number;
  };
}) => {
  const played = Boolean(item.UserData?.Played);
  const percentage = item.UserData?.PlayedPercentage;
  const isSeries = item.Type === 'Series';
  const inProgress =
    !isSeries &&
    !played &&
    ((percentage != null && percentage > 0 && percentage < 95) ||
      (item.UserData?.PlaybackPositionTicks ?? 0) > 0);
  const posterItemId =
    item.Type === 'Episode' && item.SeriesId ? item.SeriesId : item.Id;
  const unplayedItemCount = isSeries
    ? item.UserData?.UnplayedItemCount
    : undefined;

  return {
    year: item.ProductionYear,
    genres: item.Genres?.length ? item.Genres : undefined,
    watched: played,
    inProgress,
    addedAt: item.DateCreated,
    lastPlayedAt: item.UserData?.LastPlayedDate,
    posterUrl: libraryItemImageUrl(posterItemId, 'primary'),
    backdropUrl: item.BackdropImageTags?.length
      ? libraryItemImageUrl(item.Id, 'backdrop')
      : undefined,
    runtimeMinutes: runtimeMinutesFromTicks(
      item.UserData?.RunTimeTicks ?? item.RunTimeTicks
    ),
    inspectorItemId:
      item.Type === 'Episode' && item.SeriesId ? item.SeriesId : item.Id,
    ...(unplayedItemCount != null ? { unplayedItemCount } : {}),
  };
};

export const listBrowseFromClient = async (
  client: {
    browseLibraryItems: (
      params: Record<string, string | number | boolean>
    ) => Promise<{
      items: JellyfinLibraryItemExtended[];
      totalRecordCount: number;
    }>;
  },
  userId: string,
  query: ParsedLibraryBrowseQuery,
  mapItems: (items: JellyfinLibraryItemExtended[]) => Promise<LibraryTitle[]>
): Promise<{ results: LibraryTitle[]; total: number }> => {
  const params = buildJellyfinBrowseParams(query, userId);
  const { items, totalRecordCount } = await client.browseLibraryItems(params);
  return {
    results: await mapItems(items),
    total: totalRecordCount,
  };
};
