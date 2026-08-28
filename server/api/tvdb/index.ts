import ExternalAPI from '@server/api/externalapi';
import type { TvShowProvider } from '@server/api/provider';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbSeasonWithEpisodes,
  TmdbTvDetails,
  TmdbTvEpisodeResult,
  TmdbTvSeasonResult,
} from '@server/api/themoviedb/interfaces';
import {
  convertTmdbLanguageToTvdbWithFallback,
  type TvdbBaseResponse,
  type TvdbEpisode,
  type TvdbEpisodeCatalog,
  type TvdbLoginResponse,
  type TvdbSeasonDetails,
  type TvdbTvDetails,
} from '@server/api/tvdb/interfaces';
import cacheManager, { type AvailableCacheIds } from '@server/lib/cache';
import logger from '@server/logger';

interface TvdbConfig {
  baseUrl: string;
  maxRequestsPerSecond: number;
  maxRequests: number;
  cachePrefix: AvailableCacheIds;
}

const DEFAULT_CONFIG: TvdbConfig = {
  baseUrl: 'https://api4.thetvdb.com/v4',
  maxRequestsPerSecond: 50,
  maxRequests: 20,
  cachePrefix: 'tvdb' as const,
};

const enum TvdbIdStatus {
  INVALID = -1,
}

type TvdbId = number;
type ValidTvdbId = Exclude<TvdbId, TvdbIdStatus.INVALID>;

export interface TvdbRemoteIdMatch {
  tvdbId: number;
  type: 'series' | 'movie';
  name?: string;
}

class Tvdb extends ExternalAPI implements TvShowProvider {
  static instance: Tvdb;
  private readonly tmdb: TheMovieDb;
  private static readonly DEFAULT_CACHE_TTL = 43200;
  private static readonly DEFAULT_LANGUAGE = 'eng';
  private token: string;
  private pin?: string;

  constructor(pin?: string) {
    const finalConfig = { ...DEFAULT_CONFIG };
    super(
      finalConfig.baseUrl,
      {},
      {
        nodeCache: cacheManager.getCache(finalConfig.cachePrefix).data,
        rateLimit: {
          maxRequests: finalConfig.maxRequests,
          maxRPS: finalConfig.maxRequestsPerSecond,
        },
      }
    );
    this.pin = pin;
    this.tmdb = new TheMovieDb();
  }

  public static async getInstance(): Promise<Tvdb> {
    if (!this.instance) {
      this.instance = new Tvdb();
      await this.instance.login();
    }

    return this.instance;
  }

  private async refreshToken(): Promise<void> {
    try {
      if (!this.token) {
        await this.login();
        return;
      }

      const base64Url = this.token.split('.')[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(Buffer.from(base64, 'base64').toString());

      if (!payload.exp) {
        await this.login();
      }

      const now = Math.floor(Date.now() / 1000);
      const diff = payload.exp - now;

      // refresh token 1 week before expiration
      if (diff < 604800) {
        await this.login();
      }
    } catch (error) {
      this.handleError('Failed to refresh token', error);
    }
  }

  public async test(): Promise<void> {
    try {
      await this.login();
    } catch (error) {
      this.handleError('Login failed', error);
      throw error;
    }
  }

  async login(): Promise<TvdbLoginResponse> {
    let body: { apiKey: string; pin?: string } = {
      apiKey: 'd00d9ecb-a9d0-4860-958a-74b14a041405',
    };

    if (this.pin) {
      body = {
        ...body,
        pin: this.pin,
      };
    }

    const response = await this.post<TvdbBaseResponse<TvdbLoginResponse>>(
      '/login',
      {
        ...body,
      }
    );

    this.token = response.data.token;

    return response.data;
  }

  public async getShowByTvdbId({
    tvdbId,
    language,
  }: {
    tvdbId: number;
    language?: string;
  }): Promise<TmdbTvDetails> {
    try {
      const tmdbTvShow = await this.tmdb.getShowByTvdbId({
        tvdbId: tvdbId,
        language,
      });

      try {
        await this.refreshToken();

        const validTvdbId = this.getTvdbIdFromTmdb(tmdbTvShow);

        if (this.isValidTvdbId(validTvdbId)) {
          return this.enrichTmdbShowWithTvdbData(tmdbTvShow, validTvdbId);
        }

        return tmdbTvShow;
      } catch {
        return tmdbTvShow;
      }
    } catch (error) {
      this.handleError('Failed to fetch TV show details', error);
      throw error;
    }
  }

  public async getTvShow({
    tvId,
    language,
  }: {
    tvId: number;
    language?: string;
  }): Promise<TmdbTvDetails> {
    try {
      const tmdbTvShow = await this.tmdb.getTvShow({ tvId, language });

      try {
        await this.refreshToken();

        const tvdbId = this.getTvdbIdFromTmdb(tmdbTvShow);

        if (this.isValidTvdbId(tvdbId)) {
          return await this.enrichTmdbShowWithTvdbData(tmdbTvShow, tvdbId);
        }

        return tmdbTvShow;
      } catch (error) {
        this.handleError('Failed to fetch TV show details', error);
        return tmdbTvShow;
      }
    } catch (error) {
      this.handleError('Failed to fetch TV show details', error);
      return this.tmdb.getTvShow({ tvId, language });
    }
  }

  public async getTvSeason({
    tvId,
    seasonNumber,
    language = Tvdb.DEFAULT_LANGUAGE,
  }: {
    tvId: number;
    seasonNumber: number;
    language?: string;
  }): Promise<TmdbSeasonWithEpisodes> {
    try {
      const tmdbTvShow = await this.tmdb.getTvShow({ tvId, language });

      try {
        await this.refreshToken();

        const tvdbId = this.getTvdbIdFromTmdb(tmdbTvShow);

        if (!this.isValidTvdbId(tvdbId)) {
          return await this.tmdb.getTvSeason({ tvId, seasonNumber, language });
        }

        return await this.getTvdbSeasonData(
          tvdbId,
          seasonNumber,
          tvId,
          language
        );
      } catch (error) {
        this.handleError('Failed to fetch TV season details', error);
        return await this.tmdb.getTvSeason({ tvId, seasonNumber, language });
      }
    } catch (error) {
      logger.error(
        `[TVDB] Failed to fetch TV season details: ${error.message}`
      );
      throw error;
    }
  }

  public async getEpisodeCatalog({
    tvId,
    language = Tvdb.DEFAULT_LANGUAGE,
  }: {
    tvId: number;
    language?: string;
  }): Promise<TvdbEpisodeCatalog> {
    const tmdbTvShow = await this.tmdb.getTvShow({ tvId, language });
    const tvdbId = this.getTvdbIdFromTmdb(tmdbTvShow);

    if (!this.isValidTvdbId(tvdbId)) {
      throw new Error('[TVDB] TVDB ID not found for series');
    }

    await this.refreshToken();
    const show = await this.fetchTvdbShowData(tvdbId);
    const officialSeasons = new Set(
      show.seasons
        .filter((season) => season.type?.type === 'official')
        .map((season) => season.number)
    );
    const wantedLanguage = convertTmdbLanguageToTvdbWithFallback(
      language,
      Tvdb.DEFAULT_LANGUAGE
    );
    const episodes: TvdbEpisode[] = [];
    let page = 0;

    while (page < 50) {
      const response = await this.get<TvdbBaseResponse<TvdbSeasonDetails>>(
        `/series/${tvdbId}/episodes/default/${wantedLanguage}`,
        {
          headers: { Authorization: `Bearer ${this.token}` },
          params: { page },
        },
        Tvdb.DEFAULT_CACHE_TTL
      );
      const pageEpisodes = response.data?.episodes ?? [];
      episodes.push(...pageEpisodes);

      if (!response.links?.next || pageEpisodes.length === 0) {
        break;
      }
      page++;
    }

    return {
      tvdbSeriesId: tvdbId,
      episodes: episodes
        .filter((episode) => officialSeasons.has(episode.seasonNumber))
        .map((episode) => ({
          tvdbId: episode.id,
          seasonNumber: episode.seasonNumber,
          episodeNumber: episode.number,
          title: episode.name || `Episode ${episode.number}`,
          airDate: episode.aired || undefined,
        }))
        .sort(
          (a, b) =>
            a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber
        ),
    };
  }

  /**
   * `GET /search/remoteid/{id}` is the only endpoint that walks *backwards* from
   * an IMDB/TMDB/Zap2it/EIDR id to a TVDB record, and it is the sole authority on
   * TVDB's own absolute-order numbering.
   */
  public async searchRemoteId(remoteId: string): Promise<TvdbRemoteIdMatch[]> {
    await this.refreshToken();
    const response = await this.get<
      TvdbBaseResponse<
        {
          series?: { id?: number; name?: string };
          movie?: { id?: number; name?: string };
        }[]
      >
    >(
      `/search/remoteid/${encodeURIComponent(remoteId)}`,
      { headers: { Authorization: `Bearer ${this.token}` } },
      Tvdb.DEFAULT_CACHE_TTL
    );

    return (response.data ?? []).flatMap<TvdbRemoteIdMatch>((entry) => {
      if (entry.series?.id) {
        return [
          {
            tvdbId: entry.series.id,
            type: 'series' as const,
            name: entry.series.name,
          },
        ];
      }
      if (entry.movie?.id) {
        return [
          {
            tvdbId: entry.movie.id,
            type: 'movie' as const,
            name: entry.movie.name,
          },
        ];
      }
      return [];
    });
  }

  private async enrichTmdbShowWithTvdbData(
    tmdbTvShow: TmdbTvDetails,
    tvdbId: ValidTvdbId
  ): Promise<TmdbTvDetails> {
    try {
      await this.refreshToken();

      const tvdbData = await this.fetchTvdbShowData(tvdbId);
      const seasons = this.processSeasons(tvdbData);

      if (!seasons.length) {
        return tmdbTvShow;
      }

      return { ...tmdbTvShow, seasons };
    } catch (error) {
      logger.error(
        `Failed to enrich TMDB show with TVDB data: ${error.message} token: ${this.token}`
      );
      return tmdbTvShow;
    }
  }

  private async fetchTvdbShowData(tvdbId: number): Promise<TvdbTvDetails> {
    const resp = await this.get<TvdbBaseResponse<TvdbTvDetails>>(
      `/series/${tvdbId}/extended?meta=episodes&short=true`,
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      },
      Tvdb.DEFAULT_CACHE_TTL
    );

    return resp.data;
  }

  private processSeasons(tvdbData: TvdbTvDetails): TmdbTvSeasonResult[] {
    if (!tvdbData || !tvdbData.seasons || !tvdbData.episodes) {
      return [];
    }

    const seasons = tvdbData.seasons
      .filter((season) => season.type && season.type.type === 'official')
      .sort((a, b) => a.number - b.number)
      .map((season) => this.createSeasonData(season, tvdbData))
      .filter(
        (season) => season && season.season_number >= 0
      ) as TmdbTvSeasonResult[];

    return seasons;
  }

  private createSeasonData(
    season: TvdbSeasonDetails,
    tvdbData: TvdbTvDetails
  ): TmdbTvSeasonResult {
    const seasonNumber = season.number ?? -1;
    if (seasonNumber < 0) {
      return {
        id: 0,
        episode_count: 0,
        name: '',
        overview: '',
        season_number: -1,
        poster_path: '',
        air_date: '',
      };
    }

    const episodeCount = tvdbData.episodes.filter(
      (episode) => episode.seasonNumber === season.number
    ).length;

    return {
      id: tvdbData.id,
      episode_count: episodeCount,
      name: `${season.number}`,
      overview: '',
      season_number: season.number,
      poster_path: '',
      air_date: '',
    };
  }

  private async getTvdbSeasonData(
    tvdbId: number,
    seasonNumber: number,
    tvId: number,
    language: string = Tvdb.DEFAULT_LANGUAGE
  ): Promise<TmdbSeasonWithEpisodes> {
    const tvdbData = await this.fetchTvdbShowData(tvdbId);

    if (!tvdbData) {
      logger.error(`Failed to fetch TVDB data for ID: ${tvdbId}`);
      return this.createEmptySeasonResponse(tvId);
    }

    // get season id
    const season = tvdbData.seasons.find(
      (season) =>
        season.number === seasonNumber &&
        season.type.type &&
        season.type.type === 'official'
    );

    if (!season) {
      logger.error(
        `Failed to find season ${seasonNumber} for TVDB ID: ${tvdbId}`
      );
      return this.createEmptySeasonResponse(tvId);
    }

    const wantedTranslation = convertTmdbLanguageToTvdbWithFallback(
      language,
      Tvdb.DEFAULT_LANGUAGE
    );

    // check if translation is available for the season
    const availableTranslation = season.nameTranslations.filter(
      (translation) =>
        translation === wantedTranslation ||
        translation === Tvdb.DEFAULT_LANGUAGE
    );

    if (!availableTranslation) {
      return this.getSeasonWithOriginalLanguage(
        tvdbId,
        tvId,
        seasonNumber,
        season
      );
    }

    return this.getSeasonWithTranslation(
      tvdbId,
      tvId,
      seasonNumber,
      season,
      wantedTranslation
    );
  }

  private async getSeasonWithTranslation(
    tvdbId: number,
    tvId: number,
    seasonNumber: number,
    season: TvdbSeasonDetails,
    language: string
  ): Promise<TmdbSeasonWithEpisodes> {
    if (!season) {
      logger.error(
        `Failed to find season ${seasonNumber} for TVDB ID: ${tvdbId}`
      );
      return this.createEmptySeasonResponse(tvId);
    }

    const allEpisodes = [] as TvdbEpisode[];
    let page = 0;
    // Limit to max 50 pages to avoid infinite loops.
    // 50 pages with 500 items per page = 25_000 episodes in a series which should be more than enough
    const maxPages = 50;

    while (page < maxPages) {
      const resp = await this.get<TvdbBaseResponse<TvdbSeasonDetails>>(
        `/series/${tvdbId}/episodes/default/${language}`,
        {
          headers: {
            Authorization: `Bearer ${this.token}`,
          },
          params: {
            page: page,
          },
        }
      );

      if (!resp?.data?.episodes) {
        logger.warn(
          `No episodes found for TVDB ID: ${tvdbId} on page ${page} for season ${seasonNumber}`
        );
        break;
      }

      const { episodes } = resp.data;

      if (!episodes) {
        logger.debug(
          `No more episodes found for TVDB ID: ${tvdbId} on page ${page} for season ${seasonNumber}`
        );
        break;
      }

      allEpisodes.push(...episodes);

      const hasNextPage = resp.links?.next && episodes.length > 0;

      if (!hasNextPage) {
        break;
      }

      page++;
    }

    if (page >= maxPages) {
      logger.warn(
        `Reached max pages (${maxPages}) for TVDB ID: ${tvdbId} on season ${seasonNumber} with language ${language}. There might be more episodes available.`
      );
    }

    const episodes = this.processEpisodes(
      { ...season, episodes: allEpisodes },
      seasonNumber,
      tvId
    );

    return {
      episodes,
      external_ids: { tvdb_id: tvdbId },
      name: '',
      overview: '',
      id: season.id,
      air_date: season.firstAired,
      season_number: episodes.length,
    };
  }

  private async getSeasonWithOriginalLanguage(
    tvdbId: number,
    tvId: number,
    seasonNumber: number,
    season: TvdbSeasonDetails
  ): Promise<TmdbSeasonWithEpisodes> {
    if (!season) {
      logger.error(
        `Failed to find season ${seasonNumber} for TVDB ID: ${tvdbId}`
      );
      return this.createEmptySeasonResponse(tvId);
    }

    const resp = await this.get<TvdbBaseResponse<TvdbSeasonDetails>>(
      `/seasons/${season.id}/extended`,
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      }
    );

    const seasons = resp.data;

    const episodes = this.processEpisodes(seasons, seasonNumber, tvId);

    return {
      episodes,
      external_ids: { tvdb_id: tvdbId },
      name: '',
      overview: '',
      id: seasons.id,
      air_date: seasons.firstAired,
      season_number: episodes.length,
    };
  }

  private processEpisodes(
    tvdbSeason: TvdbSeasonDetails,
    seasonNumber: number,
    tvId: number
  ): TmdbTvEpisodeResult[] {
    if (!tvdbSeason || !tvdbSeason.episodes) {
      logger.error('No episodes found in TVDB season data');
      return [];
    }

    return tvdbSeason.episodes
      .filter((episode) => episode.seasonNumber === seasonNumber)
      .map((episode, index) => this.createEpisodeData(episode, index, tvId));
  }

  private createEpisodeData(
    episode: TvdbEpisode,
    index: number,
    tvId: number
  ): TmdbTvEpisodeResult {
    return {
      id: episode.id,
      air_date: episode.aired,
      episode_number: episode.number,
      name: episode.name || `Episode ${index + 1}`,
      overview: episode.overview || '',
      season_number: episode.seasonNumber,
      production_code: '',
      show_id: tvId,
      still_path:
        episode.image && !episode.image.startsWith('https://')
          ? 'https://artworks.thetvdb.com' + episode.image
          : '',
      vote_average: 1,
      vote_count: 1,
    };
  }

  private createEmptySeasonResponse(tvId: number): TmdbSeasonWithEpisodes {
    return {
      episodes: [],
      external_ids: { tvdb_id: tvId },
      name: '',
      overview: '',
      id: 0,
      air_date: '',
      season_number: 0,
    };
  }

  private getTvdbIdFromTmdb(tmdbTvShow: TmdbTvDetails): TvdbId {
    return tmdbTvShow?.external_ids?.tvdb_id ?? TvdbIdStatus.INVALID;
  }

  private isValidTvdbId(tvdbId: TvdbId): tvdbId is ValidTvdbId {
    return tvdbId !== TvdbIdStatus.INVALID;
  }

  private handleError(context: string, error: Error): void {
    throw new Error(`[TVDB] ${context}: ${error.message}`);
  }
}

export default Tvdb;
