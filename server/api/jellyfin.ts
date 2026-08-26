/* eslint-disable @typescript-eslint/no-explicit-any */
import ExternalAPI from '@server/api/externalapi';
import { ApiErrorCode } from '@server/constants/error';
import { MediaServerType } from '@server/constants/server';
import availabilitySync from '@server/lib/availabilitySync';
import {
  BROWSE_ITEM_FIELDS,
  jellyfinItemImageRequest,
  uniqueSortedGenres,
} from '@server/lib/libraryBrowse';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { ApiError } from '@server/types/error';
import { getAppVersion } from '@server/utils/appVersion';

export interface JellyfinUserResponse {
  Name: string;
  ServerId: string;
  ServerName: string;
  Id: string;
  Configuration: {
    GroupedFolders: string[];
  };
  Policy: {
    IsAdministrator: boolean;
  };
  PrimaryImageTag?: string;
}

export interface JellyfinDevice {
  Id: string;
  Name: string;
  LastUserName: string;
  AppName: string;
  AppVersion: string;
  LastUserId: string;
  DateLastActivity: string;
  Capabilities: Record<string, unknown>;
}

export interface JellyfinDevicesResponse {
  Items: JellyfinDevice[];
  TotalRecordCount: number;
  StartIndex: number;
}

export interface JellyfinLoginResponse {
  User: JellyfinUserResponse;
  AccessToken: string;
}

export interface QuickConnectInitiateResponse {
  Secret: string;
  Code: string;
  DateAdded: string;
}

export interface QuickConnectStatusResponse {
  Authenticated: boolean;
  Secret: string;
  Code: string;
  DeviceId: string;
  DeviceName: string;
  AppName: string;
  AppVersion: string;
  DateAdded: string;
}

export interface JellyfinUserListResponse {
  users: JellyfinUserResponse[];
}

interface JellyfinMediaFolder {
  Name: string;
  Id: string;
  Type: string;
  CollectionType: string;
}

export interface JellyfinLibrary {
  type: 'show' | 'movie';
  key: string;
  title: string;
  agent: string;
}

export interface JellyfinLibraryItem {
  Name: string;
  Id: string;
  HasSubtitles: boolean;
  Type: 'Movie' | 'Episode' | 'Season' | 'Series';
  LocationType: 'FileSystem' | 'Offline' | 'Remote' | 'Virtual';
  SeriesName?: string;
  SeriesId?: string;
  SeasonId?: string;
  SeasonName?: string;
  IndexNumber?: number;
  IndexNumberEnd?: number;
  ParentIndexNumber?: number;
  MediaType: string;
}

export interface JellyfinMediaStream {
  Codec: string;
  Type: 'Video' | 'Audio' | 'Subtitle';
  Height?: number;
  Width?: number;
  AverageFrameRate?: number;
  RealFrameRate?: number;
  Language?: string;
  DisplayTitle: string;
}

export interface JellyfinMediaSource {
  Protocol: string;
  Id: string;
  Path: string;
  Type: string;
  VideoType: string;
  MediaStreams: JellyfinMediaStream[];
}

export interface JellyfinLibraryItemExtended extends JellyfinLibraryItem {
  ProviderIds: {
    Tmdb?: string;
    TheMovieDb?: string;
    Imdb?: string;
    Tvdb?: string;
    AniDB?: string;
  };
  MediaSources?: JellyfinMediaSource[];
  Width?: number;
  Height?: number;
  IsHD?: boolean;
  DateCreated?: string;
  Overview?: string;
  UserData?: {
    PlaybackPositionTicks?: number;
    PlayedPercentage?: number;
    RunTimeTicks?: number;
    Played?: boolean;
    LastPlayedDate?: string;
    IsFavorite?: boolean;
    UnplayedItemCount?: number;
  };
  RunTimeTicks?: number;
  ProductionYear?: number;
  Genres?: string[];
  PremiereDate?: string;
  ImageTags?: Record<string, string>;
  BackdropImageTags?: string[];
  RecursiveItemCount?: number;
}

type EpisodeReturn<T> = T extends { includeMediaInfo: true }
  ? JellyfinLibraryItemExtended[]
  : JellyfinLibraryItem[];

export interface JellyfinItemsReponse {
  Items: JellyfinLibraryItemExtended[];
  TotalRecordCount: number;
  StartIndex: number;
}

/**
 * Jellyfin 10.11 Resume (and `/Items?Filters=IsResumable&SortBy=DatePlayed`)
 * returns items with no LastPlayedDate first; dated items last. SortBy is a
 * no-op. Continue Watching re-sorts by LastPlayedDate, newest first.
 */
export const sortResumeItemsByDatePlayed = (
  items: JellyfinLibraryItemExtended[]
): JellyfinLibraryItemExtended[] =>
  [...items].sort((a, b) => resumePlayedAtMs(b) - resumePlayedAtMs(a));

const resumePlayedAtMs = (item: JellyfinLibraryItemExtended): number => {
  const raw = item.UserData?.LastPlayedDate;
  if (!raw) {
    return 0;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const buildJellyfinAuthorizationHeader = (
  authToken?: string | null,
  deviceId?: string | null
): string => {
  const settings = getSettings();
  const safeDeviceId =
    deviceId && deviceId.length > 0
      ? deviceId
      : Buffer.from('BOT_seerr').toString('base64');

  const version =
    settings.main.mediaServerType === MediaServerType.EMBY
      ? '1.0.0'
      : getAppVersion();

  let authHeaderVal = `MediaBrowser Client="Foreseerr", Device="Foreseerr", DeviceId="${safeDeviceId}", Version="${version}"`;
  if (authToken) {
    authHeaderVal += `, Token="${authToken}"`;
  }

  return authHeaderVal;
};

class JellyfinAPI extends ExternalAPI {
  private userId?: string;
  private mediaServerType: MediaServerType;

  constructor(
    jellyfinHost: string,
    authToken?: string | null,
    deviceId?: string | null,
    timeout?: number
  ) {
    super(
      jellyfinHost,
      {},
      {
        timeout,
        headers: {
          Authorization: buildJellyfinAuthorizationHeader(authToken, deviceId),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      }
    );

    this.mediaServerType = getSettings().main.mediaServerType;
  }

  public async login(
    Username?: string,
    Password?: string,
    ClientIP?: string
  ): Promise<JellyfinLoginResponse> {
    const authenticate = async (useHeaders: boolean) => {
      const headers =
        useHeaders && ClientIP ? { 'X-Forwarded-For': ClientIP } : {};

      return this.post<JellyfinLoginResponse>(
        '/Users/AuthenticateByName',
        {
          Username,
          Pw: Password,
        },
        { headers }
      );
    };

    try {
      return await authenticate(true);
    } catch (e) {
      logger.debug('Failed to authenticate with headers', {
        label: 'Jellyfin API',
        error: e.response?.statusText,
        ip: ClientIP,
      });

      if (!e.response?.status) {
        throw new ApiError(404, ApiErrorCode.InvalidUrl);
      }

      if (e.response?.status === 401) {
        throw new ApiError(e.response?.status, ApiErrorCode.InvalidCredentials);
      }
    }

    try {
      return await authenticate(false);
    } catch (e) {
      if (e.response?.status === 401) {
        throw new ApiError(e.response?.status, ApiErrorCode.InvalidCredentials);
      }

      logger.error(
        `Something went wrong while authenticating with the Jellyfin server: ${e.message}`,
        {
          label: 'Jellyfin API',
          error: e.response?.status,
          ip: ClientIP,
        }
      );

      throw new ApiError(e.response?.status, ApiErrorCode.Unknown);
    }
  }

  public async initiateQuickConnect(): Promise<QuickConnectInitiateResponse> {
    try {
      const response = await this.post<QuickConnectInitiateResponse>(
        '/QuickConnect/Initiate'
      );

      return response;
    } catch (e) {
      logger.error(
        `Something went wrong while initiating Quick Connect: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      throw new ApiError(e.response?.status, ApiErrorCode.Unknown);
    }
  }

  public async checkQuickConnect(
    secret: string
  ): Promise<QuickConnectStatusResponse> {
    try {
      const response = await this.get<QuickConnectStatusResponse>(
        '/QuickConnect/Connect',
        { params: { secret } }
      );

      return response;
    } catch (e) {
      logger.error(
        `Something went wrong while getting Quick Connect status: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      throw new ApiError(e.response?.status, ApiErrorCode.Unknown);
    }
  }

  public async authenticateQuickConnect(
    secret: string
  ): Promise<JellyfinLoginResponse> {
    try {
      const response = await this.post<JellyfinLoginResponse>(
        '/Users/AuthenticateWithQuickConnect',
        { Secret: secret }
      );
      return response;
    } catch (e) {
      logger.error(
        `Something went wrong while authenticating with Quick Connect: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      throw new ApiError(e.response?.status, ApiErrorCode.Unknown);
    }
  }

  public setUserId(userId: string): void {
    this.userId = userId;
    return;
  }

  public async getSystemInfo(): Promise<any> {
    try {
      const systemInfoResponse = await this.get<any>('/System/Info');

      return systemInfoResponse;
    } catch (e) {
      throw new ApiError(e.response?.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async getServerName(): Promise<string> {
    try {
      const serverResponse = await this.get<JellyfinUserResponse>(
        '/System/Info/Public'
      );

      return serverResponse.ServerName;
    } catch (e) {
      logger.error(
        `Something went wrong while getting the server name from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      throw new ApiError(e.response?.status, ApiErrorCode.Unknown);
    }
  }

  public async getUsers(): Promise<JellyfinUserListResponse> {
    try {
      const userReponse = await this.get<JellyfinUserResponse[]>(`/Users`);

      return { users: userReponse };
    } catch (e) {
      logger.error(
        `Something went wrong while getting the account from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      throw new ApiError(e.response?.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async getUser(): Promise<JellyfinUserResponse> {
    try {
      const userReponse = await this.get<JellyfinUserResponse>(
        `/Users/${this.userId ?? 'Me'}`
      );
      return userReponse;
    } catch (e) {
      logger.error(
        `Something went wrong while getting the account from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      throw new ApiError(e.response?.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async getLibraries(): Promise<JellyfinLibrary[]> {
    try {
      const mediaFolderResponse = await this.get<any>(`/Library/MediaFolders`);

      return this.mapLibraries(mediaFolderResponse.Items);
    } catch {
      // fallback to user views to get libraries
      // this only and maybe/depending on factors affects LDAP users
      try {
        const mediaFolderResponse = await this.get<any>(
          `/Users/${this.userId ?? 'Me'}/Views`
        );

        return this.mapLibraries(mediaFolderResponse.Items);
      } catch (e) {
        logger.error(
          `Something went wrong while getting libraries from the Jellyfin server: ${e.message}`,
          {
            label: 'Jellyfin API',
            error: e.response?.status,
          }
        );

        return [];
      }
    }
  }

  private mapLibraries(mediaFolders: JellyfinMediaFolder[]): JellyfinLibrary[] {
    const excludedTypes = [
      'music',
      'books',
      'musicvideos',
      'homevideos',
      'boxsets',
    ];

    return mediaFolders
      .filter((Item: JellyfinMediaFolder) => {
        return (
          Item.Type === 'CollectionFolder' &&
          !excludedTypes.includes(Item.CollectionType)
        );
      })
      .map((Item: JellyfinMediaFolder) => {
        return <JellyfinLibrary>{
          key: Item.Id,
          title: Item.Name,
          type: Item.CollectionType === 'movies' ? 'movie' : 'show',
          agent: 'jellyfin',
        };
      });
  }

  public async getLibraryContents(id: string): Promise<JellyfinLibraryItem[]> {
    try {
      const libraryItemsResponse = await this.get<any>(
        `/Items?SortBy=SortName&SortOrder=Ascending&IncludeItemTypes=Series,Movie,Others&Recursive=true&StartIndex=0&ParentId=${id}&collapseBoxSetItems=false`
      );

      return libraryItemsResponse.Items.filter(
        (item: JellyfinLibraryItem) => item.LocationType !== 'Virtual'
      );
    } catch (e) {
      logger.error(
        `Something went wrong while getting library content from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e?.response?.status }
      );

      throw new ApiError(e.response?.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async getRecentlyAdded(id: string): Promise<JellyfinLibraryItem[]> {
    try {
      // /Items/Latest?Limit=12 drops new imports as soon as 12 newer titles
      // exist. SortBy=DateCreated matches Discover and Plex's addedAt window.
      // Files that preserve an old mtime still need Radarr/Sonarr hasFile scans.
      if (this.mediaServerType === MediaServerType.JELLYFIN) {
        const itemResponse = await this.get<JellyfinItemsReponse>(`/Items`, {
          params: {
            userId: this.userId ?? 'Me',
            ParentId: id,
            IncludeItemTypes: 'Movie,Series',
            Recursive: true,
            SortBy: 'DateCreated',
            SortOrder: 'Descending',
            Limit: 100,
            Fields: 'ProviderIds,DateCreated',
          },
        });
        return itemResponse.Items ?? [];
      }

      const itemResponse = await this.get<JellyfinLibraryItem[]>(
        `/Users/${this.userId}/Items/Latest?Limit=100&ParentId=${id}`
      );

      return itemResponse;
    } catch (e) {
      logger.error(
        `Something went wrong while getting library content from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      throw new ApiError(e.response?.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async getItemData(
    id: string
  ): Promise<JellyfinLibraryItemExtended | undefined> {
    const items = await this.getItemsData([id]);
    return items[0];
  }

  public async getItemsData(
    ids: string[]
  ): Promise<JellyfinLibraryItemExtended[]> {
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    if (uniqueIds.length === 0) {
      return [];
    }

    try {
      const itemResponse = await this.get<JellyfinItemsReponse>(`/Items`, {
        params: {
          ids: uniqueIds.join(','),
          userId: this.userId ?? 'Me',
          EnableUserData: true,
          fields: `${BROWSE_ITEM_FIELDS},MediaSources,Width,Height,IsHD`,
        },
      });

      return itemResponse.Items ?? [];
    } catch (e) {
      if (availabilitySync.running) {
        if (e.response?.status === 500) {
          return [];
        }
      }

      logger.error(
        `Something went wrong while getting library content from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );
      throw new ApiError(e.response?.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async getSeasons(seriesID: string): Promise<JellyfinLibraryItem[]> {
    try {
      const seasonResponse = await this.get<any>(`/Shows/${seriesID}/Seasons`, {
        params: {
          userId: this.userId ?? 'Me',
          EnableUserData: true,
          Fields: 'ProviderIds,Overview',
        },
      });

      return seasonResponse.Items;
    } catch (e) {
      logger.error(
        `Something went wrong while getting the list of seasons from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      throw new ApiError(e.response?.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async getEpisodes<
    T extends { includeMediaInfo?: boolean } | undefined = undefined,
  >(
    seriesID: string,
    seasonID: string,
    options?: T
  ): Promise<EpisodeReturn<T>> {
    try {
      const episodeResponse = await this.get<any>(
        `/Shows/${seriesID}/Episodes`,
        {
          params: {
            seasonId: seasonID,
            userId: this.userId ?? 'Me',
            EnableUserData: true,
            Fields: options?.includeMediaInfo
              ? 'MediaSources,ProviderIds,Overview'
              : 'ProviderIds,Overview',
          },
        }
      );

      return episodeResponse.Items.filter(
        (item: JellyfinLibraryItem) => item.LocationType !== 'Virtual'
      );
    } catch (e) {
      logger.error(
        `Something went wrong while getting the list of episodes from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      throw new ApiError(e.response?.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  /** All non-virtual episodes for a series in one request (no per-season N+1). */
  public async getSeriesEpisodes(
    seriesID: string
  ): Promise<JellyfinLibraryItemExtended[]> {
    try {
      const episodeResponse = await this.get<JellyfinItemsReponse>(
        `/Shows/${seriesID}/Episodes`,
        {
          params: {
            userId: this.userId ?? 'Me',
            EnableUserData: true,
            Fields: 'ProviderIds,Overview,ProductionYear',
          },
        }
      );

      return (episodeResponse.Items ?? []).filter(
        (item) => item.LocationType !== 'Virtual'
      );
    } catch (e) {
      logger.error(
        `Something went wrong while getting series episodes from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      throw new ApiError(e.response?.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async createApiToken(appName: string): Promise<string> {
    try {
      await this.post(`/Auth/Keys?App=${appName}`);
      const apiKeys = await this.get<any>(`/Auth/Keys`);
      return apiKeys.Items.reverse().find(
        (item: any) => item.AppName === appName
      ).AccessToken;
    } catch (e) {
      logger.error(
        `Something went wrong while creating an API key from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      throw new ApiError(e.response?.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  /**
   * Continue Watching / in-progress items, most recently played first.
   * `/Items/Resume` ignores SortBy, so re-sort by UserData.LastPlayedDate.
   */
  public async getResumeItems(
    limit = 20
  ): Promise<JellyfinLibraryItemExtended[]> {
    try {
      const userSegment = this.userId ?? 'Me';
      const response = await this.get<JellyfinItemsReponse>(
        `/Users/${userSegment}/Items/Resume`,
        {
          params: {
            Limit: limit,
            Fields: 'ProviderIds,Overview',
            IncludeItemTypes: 'Movie,Episode',
            EnableUserData: true,
            SortBy: 'DatePlayed',
            SortOrder: 'Descending',
          },
        }
      );
      return sortResumeItemsByDatePlayed(response.Items ?? []);
    } catch (e) {
      logger.error(
        `Something went wrong while getting resume items from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e?.response?.status }
      );
      throw new ApiError(e.response?.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  /**
   * Recently added movies/series by DateCreated (library ingest time).
   * Prefer /Items SortBy=DateCreated over /Items/Latest — Latest does not
   * match strict date-added order (verified against live Jellyfin).
   */
  public async getUserLatestItems(
    limit = 20
  ): Promise<JellyfinLibraryItemExtended[]> {
    try {
      const response = await this.get<JellyfinItemsReponse>(`/Items`, {
        params: {
          userId: this.userId ?? 'Me',
          IncludeItemTypes: 'Movie,Series',
          Recursive: true,
          SortBy: 'DateCreated',
          SortOrder: 'Descending',
          Limit: limit,
          Fields: BROWSE_ITEM_FIELDS,
          EnableUserData: true,
        },
      });
      return response.Items ?? [];
    } catch (e) {
      logger.error(
        `Something went wrong while getting latest items from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e?.response?.status }
      );
      throw new ApiError(e.response?.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  /**
   * Recently added episodes by Jellyfin DateCreated (library ingest time).
   * Prefer /Items SortBy=DateCreated over /Items/Latest — Latest does not
   * match strict date-added order (verified against live Jellyfin).
   */
  public async getUserLatestEpisodes(
    limit = 20,
    parentId?: string
  ): Promise<JellyfinLibraryItemExtended[]> {
    try {
      const response = await this.get<JellyfinItemsReponse>(`/Items`, {
        params: {
          userId: this.userId ?? 'Me',
          IncludeItemTypes: 'Episode',
          Recursive: true,
          SortBy: 'DateCreated',
          SortOrder: 'Descending',
          Limit: limit,
          Fields: 'ProviderIds,Overview,DateCreated,PremiereDate',
          EnableUserData: true,
          ...(parentId ? { ParentId: parentId } : {}),
        },
      });
      const items = response.Items ?? [];
      return items.filter((item) => item.Type === 'Episode');
    } catch (e) {
      logger.error(
        `Something went wrong while getting latest episodes from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e?.response?.status }
      );
      throw new ApiError(e.response?.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  /** Next-up episodes for the user, optionally scoped to one series. */
  public async getNextUpEpisodes(
    limit = 24,
    seriesId?: string
  ): Promise<JellyfinLibraryItemExtended[]> {
    try {
      const response = await this.get<JellyfinItemsReponse>(`/Shows/NextUp`, {
        params: {
          UserId: this.userId ?? 'Me',
          Limit: limit,
          Fields: 'ProviderIds,Overview',
          EnableUserData: true,
          ...(seriesId ? { SeriesId: seriesId } : {}),
        },
      });
      return response.Items ?? [];
    } catch (e) {
      logger.error(
        `Something went wrong while getting next-up episodes from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e?.response?.status }
      );
      throw new ApiError(e.response?.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async markPlayed(itemId: string): Promise<void> {
    try {
      const userSegment = this.userId ?? 'Me';
      await this.post(`/Users/${userSegment}/PlayedItems/${itemId}`, {});
    } catch (e) {
      logger.error(
        `Something went wrong while marking item as played on Jellyfin: ${e.message}`,
        { label: 'Jellyfin API', error: e?.response?.status }
      );
      throw new ApiError(e.response?.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async markUnplayed(itemId: string): Promise<void> {
    try {
      const userSegment = this.userId ?? 'Me';
      await this.axios.delete(`/Users/${userSegment}/PlayedItems/${itemId}`);
    } catch (e) {
      logger.error(
        `Something went wrong while marking item as unplayed on Jellyfin: ${e.message}`,
        { label: 'Jellyfin API', error: e?.response?.status }
      );
      throw new ApiError(e.response?.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  /** Search Movies/Series in libraries visible to the authenticated user. */
  public async searchLibraryItems(
    query: string,
    options: {
      limit?: number;
      startIndex?: number;
      mediaType?: 'movie' | 'tv';
    } = {}
  ): Promise<JellyfinLibraryItemExtended[]> {
    try {
      const include =
        options.mediaType === 'movie'
          ? 'Movie'
          : options.mediaType === 'tv'
            ? 'Series'
            : 'Movie,Series';
      const response = await this.get<JellyfinItemsReponse>(`/Items`, {
        params: {
          SearchTerm: query,
          Recursive: true,
          StartIndex: Math.max(0, options.startIndex ?? 0),
          Limit: options.limit ?? 20,
          Fields: BROWSE_ITEM_FIELDS,
          IncludeItemTypes: include,
          EnableUserData: true,
          userId: this.userId ?? 'Me',
        },
      });
      return response.Items ?? [];
    } catch (e) {
      logger.error(
        `Something went wrong while searching the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e?.response?.status }
      );
      throw new ApiError(e.response?.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async browseLibraryItems(
    params: Record<string, string | number | boolean>
  ): Promise<{
    items: JellyfinLibraryItemExtended[];
    totalRecordCount: number;
  }> {
    try {
      const response = await this.get<JellyfinItemsReponse>(`/Items`, {
        params,
      });
      return {
        items: response.Items ?? [],
        totalRecordCount: response.TotalRecordCount ?? 0,
      };
    } catch (e) {
      logger.error(
        `Something went wrong while browsing the Jellyfin library: ${e.message}`,
        { label: 'Jellyfin API', error: e?.response?.status }
      );
      throw new ApiError(e.response?.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async getPlayedLibraryItems(
    options: { limit?: number } = {}
  ): Promise<JellyfinLibraryItemExtended[]> {
    const pageSize = 250;
    const maxItems = options.limit ?? 5000;
    const items: JellyfinLibraryItemExtended[] = [];
    let startIndex = 0;

    while (items.length < maxItems) {
      const take = Math.min(pageSize, maxItems - items.length);
      const page = await this.browseLibraryItems({
        userId: this.userId ?? 'Me',
        Recursive: true,
        IncludeItemTypes: 'Movie,Series',
        Filters: 'IsPlayed',
        Fields: 'ProviderIds',
        EnableUserData: true,
        StartIndex: startIndex,
        Limit: take,
      });
      items.push(...page.items);
      if (
        page.items.length === 0 ||
        items.length >= page.totalRecordCount ||
        page.items.length < take
      ) {
        break;
      }
      startIndex += page.items.length;
    }

    return items;
  }

  public async getLibraryGenres(mediaType?: 'movie' | 'tv'): Promise<string[]> {
    const include =
      mediaType === 'movie'
        ? 'Movie'
        : mediaType === 'tv'
          ? 'Series'
          : 'Movie,Series';
    const params = {
      userId: this.userId ?? 'Me',
      IncludeItemTypes: include,
      Recursive: true,
    };

    try {
      const filters2 = await this.get<{ Genres?: { Name?: string }[] }>(
        `/Items/Filters2`,
        { params }
      );
      const genres = uniqueSortedGenres(
        (filters2.Genres ?? []).map((genre) => genre.Name)
      );
      if (genres.length) {
        return genres;
      }
    } catch (e) {
      logger.debug(
        `Jellyfin Filters2 unavailable, falling back to Filters: ${e.message}`,
        { label: 'Jellyfin API' }
      );
    }

    try {
      const filters = await this.get<{ Genres?: string[] }>(`/Items/Filters`, {
        params,
      });
      const genres = uniqueSortedGenres(filters.Genres ?? []);
      if (genres.length) {
        return genres;
      }
    } catch (e) {
      logger.debug(
        `Jellyfin Filters unavailable, falling back to Genres: ${e.message}`,
        { label: 'Jellyfin API' }
      );
    }

    try {
      const response = await this.get<{ Items?: { Name?: string }[] }>(
        `/Genres`,
        { params }
      );
      return uniqueSortedGenres(
        (response.Items ?? []).map((item) => item.Name)
      );
    } catch (e) {
      logger.error(
        `Something went wrong while getting Jellyfin genres: ${e.message}`,
        { label: 'Jellyfin API', error: e?.response?.status }
      );
      throw new ApiError(e.response?.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async getLibraryYearBound(
    order: 'Ascending' | 'Descending',
    mediaType?: 'movie' | 'tv'
  ): Promise<number | undefined> {
    const include =
      mediaType === 'movie'
        ? 'Movie'
        : mediaType === 'tv'
          ? 'Series'
          : 'Movie,Series';
    try {
      const response = await this.get<JellyfinItemsReponse>(`/Items`, {
        params: {
          userId: this.userId ?? 'Me',
          IncludeItemTypes: include,
          Recursive: true,
          SortBy: 'ProductionYear',
          SortOrder: order,
          Limit: 1,
          Fields: 'PremiereDate,ProductionYear',
        },
      });
      const item = response.Items?.[0];
      if (item?.ProductionYear) {
        return item.ProductionYear;
      }
      if (item?.PremiereDate) {
        const year = new Date(item.PremiereDate).getUTCFullYear();
        return Number.isFinite(year) ? year : undefined;
      }
      return undefined;
    } catch (e) {
      logger.error(
        `Something went wrong while getting Jellyfin year bounds: ${e.message}`,
        { label: 'Jellyfin API', error: e?.response?.status }
      );
      throw new ApiError(e.response?.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async getLibraryFacets(mediaType?: 'movie' | 'tv'): Promise<{
    genres: string[];
    yearMin?: number;
    yearMax?: number;
  }> {
    const [genres, yearMin, yearMax] = await Promise.all([
      this.getLibraryGenres(mediaType),
      this.getLibraryYearBound('Ascending', mediaType),
      this.getLibraryYearBound('Descending', mediaType),
    ]);
    return { genres, yearMin, yearMax };
  }

  public async getItemImage(
    jellyfinItemId: string,
    imageType: 'primary' | 'backdrop'
  ): Promise<{ buffer: Buffer; contentType: string } | undefined> {
    const { path, params } = jellyfinItemImageRequest(
      jellyfinItemId,
      imageType
    );
    try {
      const response = await this.axios.get<ArrayBuffer>(path, {
        params,
        responseType: 'arraybuffer',
        headers: { Accept: 'image/*' },
        validateStatus: (status) => status === 200 || status === 404,
      });
      if (response.status === 404 || !response.data) {
        return undefined;
      }
      const contentType =
        typeof response.headers['content-type'] === 'string'
          ? response.headers['content-type']
          : 'image/jpeg';
      return { buffer: Buffer.from(response.data), contentType };
    } catch (e) {
      logger.error(
        `Something went wrong while getting a Jellyfin image: ${e.message}`,
        { label: 'Jellyfin API', error: e?.response?.status }
      );
      throw new ApiError(e.response?.status, ApiErrorCode.InvalidAuthToken);
    }
  }
}

export default JellyfinAPI;
