import type {
  AnilistMedia,
  AnilistMediaListCollection,
  AnilistMediaListEntry,
  AnilistMediaListStatus,
  AnilistMediaPage,
  AnilistMediaSeason,
  AnilistMediaSort,
  AnilistTokenResponse,
  AnilistTokenState,
  AnilistViewer,
} from '@server/api/anilist/interfaces';
import {
  ANILIST_GRAPHQL_URL,
  ANILIST_OAUTH_AUTHORIZE_URL,
  ANILIST_OAUTH_PIN_REDIRECT,
  ANILIST_OAUTH_TOKEN_URL,
} from '@server/api/anilist/interfaces';
import ExternalAPI from '@server/api/externalapi';
import cacheManager from '@server/lib/cache';
import logger from '@server/logger';
import { proxyRequestInterceptor } from '@server/utils/customProxyAgent';
import axios from 'axios';

const ANILIST_PAGE_SIZE = 20;
const ANILIST_TOKEN_TTL_FALLBACK_SECONDS = 365 * 24 * 60 * 60;
const PUBLIC_PAGE_CACHE_TTL_SECONDS = 300;

const MEDIA_FIELDS = `
  id
  idMal
  title { romaji english native }
  format
  seasonYear
  startDate { year }
`;

const PAGE_MEDIA_QUERY = `
  query PageMedia(
    $page: Int
    $perPage: Int
    $sort: [MediaSort]
    $season: MediaSeason
    $seasonYear: Int
    $type: MediaType
  ) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { currentPage hasNextPage lastPage perPage total }
      media(
        type: $type
        sort: $sort
        season: $season
        seasonYear: $seasonYear
      ) {
        ${MEDIA_FIELDS}
      }
    }
  }
`;

const VIEWER_QUERY = `
  query Viewer {
    Viewer { id name }
  }
`;

const MEDIA_LIST_COLLECTION_QUERY = `
  query MediaListCollection($userId: Int!) {
    MediaListCollection(userId: $userId, type: ANIME) {
      lists {
        name
        isCustomList
        status
        entries {
          id
          status
          score(format: POINT_10)
          scoreRaw: score(format: POINT_100)
          media { ${MEDIA_FIELDS} }
        }
      }
    }
  }
`;

const SAVE_MEDIA_LIST_ENTRY_MUTATION = `
  mutation SaveMediaListEntry(
    $mediaId: Int
    $status: MediaListStatus
    $scoreRaw: Int
  ) {
    SaveMediaListEntry(mediaId: $mediaId, status: $status, scoreRaw: $scoreRaw) {
      id
      status
      score(format: POINT_10)
      scoreRaw: score(format: POINT_100)
      media { ${MEDIA_FIELDS} }
    }
  }
`;

const DELETE_MEDIA_LIST_ENTRY_MUTATION = `
  mutation DeleteMediaListEntry($id: Int) {
    DeleteMediaListEntry(id: $id) { deleted }
  }
`;

export class AnilistRateLimitedError extends Error {
  public readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds = 60) {
    super(`AniList API rate limited; retry after ${retryAfterSeconds}s`);
    this.name = 'AnilistRateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class AnilistAuthError extends Error {
  constructor(
    message = 'AniList authorization expired; reconnect your account'
  ) {
    super(message);
    this.name = 'AnilistAuthError';
  }
}

export class AnilistGraphQLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnilistGraphQLError';
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message?: string; status?: number }[];
}

interface AnilistAPIOptions {
  accessToken?: string;
}

class AnilistAPI extends ExternalAPI {
  private accessToken?: string;

  constructor(options: AnilistAPIOptions = {}) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (options.accessToken) {
      headers.Authorization = `Bearer ${options.accessToken}`;
    }

    super(
      ANILIST_GRAPHQL_URL,
      {},
      {
        headers,
        nodeCache: cacheManager.getCache('anilist').data,
        rateLimit: {
          maxRPS: 1,
          maxRequests: 90,
        },
      }
    );

    this.accessToken = options.accessToken;
  }

  static buildAuthorizeUrl(clientId: string): string {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: ANILIST_OAUTH_PIN_REDIRECT,
      response_type: 'code',
    });
    return `${ANILIST_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
  }

  static async exchangePinCode(
    clientId: string,
    clientSecret: string,
    code: string
  ): Promise<AnilistTokenState> {
    const tokenClient = axios.create({
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
    tokenClient.interceptors.request.use(proxyRequestInterceptor);

    try {
      const response = await tokenClient.post<AnilistTokenResponse>(
        ANILIST_OAUTH_TOKEN_URL,
        {
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: ANILIST_OAUTH_PIN_REDIRECT,
          code,
        }
      );
      const accessToken = String(response.data?.access_token ?? '').trim();
      if (!accessToken) {
        throw new AnilistAuthError('AniList did not return an access token');
      }
      const expiresIn =
        Number(response.data.expires_in) > 0
          ? Number(response.data.expires_in)
          : ANILIST_TOKEN_TTL_FALLBACK_SECONDS;
      return {
        accessToken,
        expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
      };
    } catch (e) {
      if (e instanceof AnilistAuthError) {
        throw e;
      }
      const status = axios.isAxiosError(e) ? e.response?.status : undefined;
      logger.warn('AniList PIN token exchange failed', {
        label: 'AniList API',
        status,
        errorMessage: e instanceof Error ? e.message : 'unknown error',
      });
      throw new AnilistAuthError(
        'Unable to exchange AniList authorization code'
      );
    }
  }

  static currentSeason(now = new Date()): {
    season: AnilistMediaSeason;
    year: number;
  } {
    const month = now.getMonth();
    const year = now.getFullYear();
    if (month <= 2) {
      return { season: 'WINTER', year };
    }
    if (month <= 5) {
      return { season: 'SPRING', year };
    }
    if (month <= 8) {
      return { season: 'SUMMER', year };
    }
    return { season: 'FALL', year };
  }

  async ping(): Promise<void> {
    // AniList rejects Page queries that only ask for pageInfo ("No field provided").
    await this.graphql<{
      Page: { pageInfo: { currentPage?: number }; media: { id: number }[] };
    }>(
      `query {
        Page(page: 1, perPage: 1) {
          pageInfo { currentPage }
          media { id }
        }
      }`,
      {},
      PUBLIC_PAGE_CACHE_TTL_SECONDS
    );
  }

  async getTrending(page = 1): Promise<AnilistMediaPage> {
    return this.getMediaPage(page, { sort: 'TRENDING_DESC' });
  }

  async getSeason(
    page = 1,
    season?: { season: AnilistMediaSeason; year: number }
  ): Promise<AnilistMediaPage> {
    const current = season ?? AnilistAPI.currentSeason();
    return this.getMediaPage(page, {
      sort: 'POPULARITY_DESC',
      season: current.season,
      seasonYear: current.year,
    });
  }

  async getViewer(): Promise<AnilistViewer> {
    const data = await this.graphql<{ Viewer: AnilistViewer }>(
      VIEWER_QUERY,
      {},
      0
    );
    if (!data.Viewer?.id) {
      throw new AnilistAuthError('AniList Viewer query returned no user');
    }
    return data.Viewer;
  }

  async getMediaListCollection(
    userId: number
  ): Promise<AnilistMediaListCollection> {
    const data = await this.graphql<{
      MediaListCollection: AnilistMediaListCollection;
    }>(MEDIA_LIST_COLLECTION_QUERY, { userId }, 0);
    return {
      lists: data.MediaListCollection?.lists ?? [],
    };
  }

  async saveMediaListEntry(options: {
    mediaId: number;
    status?: AnilistMediaListStatus;
    scoreRaw?: number | null;
  }): Promise<AnilistMediaListEntry> {
    const variables: Record<string, unknown> = { mediaId: options.mediaId };
    if (options.status) {
      variables.status = options.status;
    }
    if (options.scoreRaw != null) {
      variables.scoreRaw = options.scoreRaw;
    }
    const data = await this.graphql<{
      SaveMediaListEntry: AnilistMediaListEntry;
    }>(SAVE_MEDIA_LIST_ENTRY_MUTATION, variables, 0);
    return data.SaveMediaListEntry;
  }

  async deleteMediaListEntry(entryId: number): Promise<boolean> {
    const data = await this.graphql<{
      DeleteMediaListEntry: { deleted?: boolean } | null;
    }>(DELETE_MEDIA_LIST_ENTRY_MUTATION, { id: entryId }, 0);
    return Boolean(data.DeleteMediaListEntry?.deleted);
  }

  mediaTitle(media?: AnilistMedia | null): string {
    return (
      media?.title?.english?.trim() ||
      media?.title?.romaji?.trim() ||
      media?.title?.native?.trim() ||
      ''
    );
  }

  private async getMediaPage(
    page: number,
    options: {
      sort: AnilistMediaSort;
      season?: AnilistMediaSeason;
      seasonYear?: number;
    }
  ): Promise<AnilistMediaPage> {
    const data = await this.graphql<{ Page: AnilistMediaPage }>(
      PAGE_MEDIA_QUERY,
      {
        page,
        perPage: ANILIST_PAGE_SIZE,
        type: 'ANIME',
        sort: [options.sort],
        season: options.season,
        seasonYear: options.seasonYear,
      },
      PUBLIC_PAGE_CACHE_TTL_SECONDS
    );
    return {
      pageInfo: data.Page?.pageInfo ?? {
        hasNextPage: false,
        currentPage: page,
      },
      media: (data.Page?.media ?? []).filter(
        (item) => item?.id && item.format !== 'MUSIC'
      ),
    };
  }

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    ttl: number
  ): Promise<T> {
    try {
      const response = await this.post<GraphQLResponse<T>>(
        '',
        { query, variables },
        this.accessToken
          ? { headers: { Authorization: `Bearer ${this.accessToken}` } }
          : undefined,
        ttl
      );

      const graphQlStatus = response.errors?.[0]?.status;
      if (graphQlStatus === 401 || graphQlStatus === 403) {
        throw new AnilistAuthError();
      }
      if (response.errors?.length) {
        throw new AnilistGraphQLError(
          response.errors[0]?.message || 'AniList GraphQL error'
        );
      }
      if (!response.data) {
        throw new AnilistGraphQLError('AniList returned an empty response');
      }
      return response.data;
    } catch (e) {
      if (
        e instanceof AnilistAuthError ||
        e instanceof AnilistGraphQLError ||
        e instanceof AnilistRateLimitedError
      ) {
        throw e;
      }
      const status = axios.isAxiosError(e) ? e.response?.status : undefined;
      if (status === 429) {
        const retryAfter = Number(
          axios.isAxiosError(e)
            ? (e.response?.headers?.['retry-after'] ??
                e.response?.headers?.['Retry-After'])
            : 60
        );
        throw new AnilistRateLimitedError(
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60
        );
      }
      if (status === 401 || status === 403) {
        throw new AnilistAuthError();
      }
      throw e;
    }
  }
}

export default AnilistAPI;
