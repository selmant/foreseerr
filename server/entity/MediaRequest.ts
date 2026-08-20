import TheMovieDb from '@server/api/themoviedb';
import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import type { TmdbKeyword } from '@server/api/themoviedb/interfaces';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import OverrideRule from '@server/entity/OverrideRule';
import type { MediaRequestBody } from '@server/interfaces/api/requestInterfaces';
import { isAnimeMedia } from '@server/lib/anime/detect';
import {
  episodeRequestsAvailable,
  getResolvedTvdbEpisodeSelection,
  ongoingEpisodeRequestLockKey,
  parseEpisodeSelection,
  withOngoingEpisodeRequestLock,
  type ResolvedEpisodeSelection,
} from '@server/lib/episodeRequests';
import notificationManager, { Notification } from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import { isSeasonCoveredForFullRequest } from '@server/lib/seasonRequests';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import { truncate } from 'lodash';
import {
  AfterInsert,
  AfterLoad,
  AfterUpdate,
  Column,
  Entity,
  Index,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  RelationCount,
  UpdateDateColumn,
} from 'typeorm';
import EpisodeRequest from './EpisodeRequest';
import Media from './Media';
import SeasonRequest from './SeasonRequest';
import { User } from './User';

export class RequestPermissionError extends Error {}
export class QuotaRestrictedError extends Error {}
export class DuplicateMediaRequestError extends Error {}
export class NoSeasonsAvailableError extends Error {}
export class BlocklistedMediaError extends Error {}
export class InvalidEpisodeSelectionError extends Error {}
export class EpisodeRequestsUnavailableError extends Error {}

export const isOngoingEpisodeRequestConflict = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const queryError = error as {
    code?: string;
    constraint?: string;
    message?: string;
    driverError?: {
      code?: string;
      constraint?: string;
      message?: string;
    };
  };
  const databaseError = queryError.driverError ?? queryError;

  return (
    (databaseError.code === '23505' &&
      databaseError.constraint ===
        'IDX_media_request_active_ongoing_episode') ||
    (databaseError.code === 'SQLITE_CONSTRAINT' &&
      databaseError.message?.includes(
        'media_request.ongoingEpisodeRequestKey'
      ) === true)
  );
};

type MediaRequestOptions = {
  isAutoRequest?: boolean;
};

type RequestPlanBase = {
  media: Media;
  requestedBy: User;
  status: MediaRequestStatus;
  modifiedBy?: User;
  is4k: boolean;
  serverId?: number;
  profileId?: number;
  rootFolder?: string;
  languageProfileId?: number;
  tags?: number[];
  isAutoRequest: boolean;
  ignoreQuota: boolean;
};

/**
 * A validated request ready to be persisted. Keeping the three request shapes
 * discriminated prevents movie, full-season, and episode fields from being
 * accidentally combined while the policy code evolves.
 */
export type RequestPlan =
  | (RequestPlanBase & { kind: 'movie' })
  | (RequestPlanBase & {
      kind: 'episodes';
      episodes: ResolvedEpisodeSelection['episodes'];
      episodeSelection: ResolvedEpisodeSelection;
    })
  | (RequestPlanBase & { kind: 'seasons'; seasons: number[] });

export type RequestPlanInput = {
  media: Media;
  requestBody: MediaRequestBody;
  requestUser: User;
  actor: User;
  serverId?: number;
  profileId?: number;
  rootFolder?: string;
  languageProfileId?: number;
  tags?: number[];
  isAutoRequest: boolean;
  ignoreQuota: boolean;
};

const autoApprovalStatus = (
  actor: User,
  mediaType: MediaType,
  is4k: boolean
): { status: MediaRequestStatus; modifiedBy?: User } => {
  const approved = actor.hasPermission(
    [
      is4k ? Permission.AUTO_APPROVE_4K : Permission.AUTO_APPROVE,
      mediaType === MediaType.MOVIE
        ? is4k
          ? Permission.AUTO_APPROVE_4K_MOVIE
          : Permission.AUTO_APPROVE_MOVIE
        : is4k
          ? Permission.AUTO_APPROVE_4K_TV
          : Permission.AUTO_APPROVE_TV,
      Permission.MANAGE_REQUESTS,
    ],
    { type: 'or' }
  );
  return {
    status: approved ? MediaRequestStatus.APPROVED : MediaRequestStatus.PENDING,
    ...(approved ? { modifiedBy: actor } : {}),
  };
};

const baseRequestPlan = (
  input: RequestPlanInput,
  mediaType: MediaType
): RequestPlanBase => ({
  media: input.media,
  requestedBy: input.requestUser,
  ...autoApprovalStatus(
    input.actor,
    mediaType,
    input.requestBody.is4k ?? false
  ),
  is4k: input.requestBody.is4k ?? false,
  serverId: input.serverId,
  profileId: input.profileId,
  rootFolder: input.rootFolder,
  languageProfileId: input.languageProfileId,
  tags: input.tags,
  isAutoRequest: input.isAutoRequest,
  ignoreQuota: input.ignoreQuota,
});

export const buildMovieRequestPlan = (
  input: RequestPlanInput
): RequestPlan => ({
  kind: 'movie',
  ...baseRequestPlan(input, MediaType.MOVIE),
});

export const buildEpisodeRequestPlan = ({
  input,
  selection,
  activeRequests,
  quotas,
}: {
  input: RequestPlanInput;
  selection: ResolvedEpisodeSelection;
  activeRequests: MediaRequest[];
  quotas: Awaited<ReturnType<User['getQuota']>>;
}): RequestPlan => {
  if (
    selection.type === 'after' &&
    activeRequests.some((request) => request.episodeSelectionType === 'after')
  ) {
    throw new DuplicateMediaRequestError(
      'An ongoing episode request already exists for this series.'
    );
  }

  const coveredSeasons = new Set(
    activeRequests.flatMap((request) =>
      (request.seasons ?? []).map((season) => season.seasonNumber)
    )
  );
  const coveredEpisodes = new Set(
    activeRequests.flatMap((request) =>
      (request.episodes ?? []).map((episode) => episode.tvdbId)
    )
  );
  const episodes =
    selection.type === 'after'
      ? selection.episodes
      : selection.episodes.filter(
          (episode) =>
            !coveredSeasons.has(episode.seasonNumber) &&
            !coveredEpisodes.has(episode.tvdbId) &&
            !input.media.seasons?.some(
              (season) =>
                season.seasonNumber === episode.seasonNumber &&
                season[input.requestBody.is4k ? 'status4k' : 'status'] ===
                  MediaStatus.AVAILABLE
            )
        );

  if (episodes.length === 0) {
    throw new NoSeasonsAvailableError('No episodes available to request');
  }

  const tvQuotaUnits = new Set(episodes.map((episode) => episode.seasonNumber))
    .size;
  if (
    !input.ignoreQuota &&
    quotas.tv.limit &&
    tvQuotaUnits > (quotas.tv.remaining ?? 0)
  ) {
    throw new QuotaRestrictedError('Series Quota exceeded.');
  }

  return {
    kind: 'episodes',
    ...baseRequestPlan(input, MediaType.TV),
    episodes,
    episodeSelection: selection,
  };
};

export const buildSeasonRequestPlan = ({
  input,
  requestedSeasons,
  quotas,
}: {
  input: RequestPlanInput;
  requestedSeasons: number[];
  quotas: Awaited<ReturnType<User['getQuota']>>;
}): RequestPlan => {
  let existingSeasons = (input.media.requests ?? [])
    .filter(
      (request) =>
        request.is4k === input.requestBody.is4k &&
        request.status !== MediaRequestStatus.DECLINED &&
        request.status !== MediaRequestStatus.COMPLETED
    )
    .flatMap((request) =>
      (request.seasons ?? []).map((season) => season.seasonNumber)
    );

  const activeEpisodeRequestedSeasons = new Set(
    (input.media.requests ?? [])
      .filter(
        (request) =>
          request.is4k === input.requestBody.is4k &&
          request.status !== MediaRequestStatus.DECLINED &&
          request.status !== MediaRequestStatus.COMPLETED
      )
      .flatMap((request) =>
        (request.episodes ?? []).map((episode) => episode.seasonNumber)
      )
  );
  existingSeasons = [
    ...existingSeasons,
    ...(input.media.seasons ?? [])
      .filter((season) =>
        isSeasonCoveredForFullRequest(
          season[input.requestBody.is4k ? 'status4k' : 'status'],
          activeEpisodeRequestedSeasons.has(season.seasonNumber)
        )
      )
      .map((season) => season.seasonNumber),
  ];

  const seasons = requestedSeasons.filter(
    (season) => !existingSeasons.includes(season)
  );
  if (seasons.length === 0) {
    throw new NoSeasonsAvailableError('No seasons available to request');
  }
  if (
    !input.ignoreQuota &&
    quotas.tv.limit &&
    seasons.length > (quotas.tv.remaining ?? 0)
  ) {
    throw new QuotaRestrictedError('Series Quota exceeded.');
  }

  return {
    kind: 'seasons',
    ...baseRequestPlan(input, MediaType.TV),
    seasons,
  };
};

/** Convert a plan to its cascade-ready entity graph without performing I/O. */
export const materializeRequestPlan = (plan: RequestPlan): MediaRequest => {
  const request = new MediaRequest({
    type: plan.kind === 'movie' ? MediaType.MOVIE : MediaType.TV,
    media: plan.media,
    requestedBy: plan.requestedBy,
    status: plan.status,
    modifiedBy: plan.modifiedBy,
    is4k: plan.is4k,
    serverId: plan.serverId,
    profileId: plan.profileId,
    rootFolder: plan.rootFolder,
    languageProfileId: plan.languageProfileId,
    tags: plan.tags,
    isAutoRequest: plan.isAutoRequest,
    ignoreQuota: plan.ignoreQuota,
  });

  if (plan.kind === 'episodes') {
    request.seasons = [];
    request.episodes = plan.episodes.map(
      (episode) =>
        new EpisodeRequest({
          tvdbId: episode.tvdbId,
          seasonNumber: episode.seasonNumber,
          episodeNumber: episode.episodeNumber,
          title: episode.title,
          airDate: episode.airDate,
          status: plan.status,
        })
    );
    request.episodeSelectionType = plan.episodeSelection.type;
    request.episodeStartTvdbId = plan.episodeSelection.startTvdbId;
    request.episodeEndTvdbId = plan.episodeSelection.endTvdbId;
    request.ongoingEpisodeRequestKey =
      plan.episodeSelection.type === 'after'
        ? ongoingEpisodeRequestLockKey(plan.media.tmdbId, plan.is4k)
        : undefined;
    request.tvQuotaUnits = new Set(
      plan.episodes.map((episode) => episode.seasonNumber)
    ).size;
  } else if (plan.kind === 'seasons') {
    request.seasons = plan.seasons.map(
      (seasonNumber) => new SeasonRequest({ seasonNumber, status: plan.status })
    );
    request.episodes = [];
    request.tvQuotaUnits = plan.seasons.length;
  }

  return request;
};

@Entity()
@Index(
  'IDX_media_request_active_ongoing_episode',
  ['ongoingEpisodeRequestKey'],
  {
    unique: true,
    where: '"episodeSelectionType" = \'after\' AND "status" NOT IN (3, 5)',
  }
)
export class MediaRequest {
  /** Persist the already-validated plan atomically with its Media row. */
  private static async persistPlan(plan: RequestPlan): Promise<MediaRequest> {
    const request = materializeRequestPlan(plan);
    await dataSource.transaction(async (manager) => {
      request.media = await manager.getRepository(Media).save(plan.media);
      await manager.getRepository(MediaRequest).save(request);
    });
    return request;
  }

  public static async request(
    requestBody: MediaRequestBody,
    user: User,
    options: MediaRequestOptions = {}
  ): Promise<MediaRequest> {
    const tmdb = new TheMovieDb();
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const userRepository = getRepository(User);
    const settings = getSettings();

    let requestUser = user;

    if (
      requestBody.userId &&
      !requestUser.hasPermission([
        Permission.MANAGE_USERS,
        Permission.MANAGE_REQUESTS,
      ])
    ) {
      throw new RequestPermissionError(
        'You do not have permission to modify the request user.'
      );
    } else if (requestBody.userId) {
      requestUser = await userRepository.findOneOrFail({
        where: { id: requestBody.userId },
      });
    }

    if (!requestUser) {
      throw new Error('User missing from request context.');
    }

    if (
      requestBody.mediaType === MediaType.MOVIE &&
      !requestUser.hasPermission(
        requestBody.is4k
          ? [Permission.REQUEST_4K, Permission.REQUEST_4K_MOVIE]
          : [Permission.REQUEST, Permission.REQUEST_MOVIE],
        {
          type: 'or',
        }
      )
    ) {
      throw new RequestPermissionError(
        `You do not have permission to make ${
          requestBody.is4k ? '4K ' : ''
        }movie requests.`
      );
    } else if (
      requestBody.mediaType === MediaType.TV &&
      !requestUser.hasPermission(
        requestBody.is4k
          ? [Permission.REQUEST_4K, Permission.REQUEST_4K_TV]
          : [Permission.REQUEST, Permission.REQUEST_TV],
        {
          type: 'or',
        }
      )
    ) {
      throw new RequestPermissionError(
        `You do not have permission to make ${
          requestBody.is4k ? '4K ' : ''
        }series requests.`
      );
    }

    const quotas = await requestUser.getQuota();

    const canBypassQuota = user.hasPermission(Permission.MANAGE_REQUESTS);
    const ignoreQuota =
      requestBody.ignoreQuota === true &&
      canBypassQuota &&
      ((requestBody.mediaType === MediaType.MOVIE
        ? quotas.movie.limit
        : quotas.tv.limit) ?? 0) > 0;

    if (!ignoreQuota) {
      if (requestBody.ignoreQuota && !canBypassQuota) {
        throw new RequestPermissionError(
          'You do not have permission to bypass user quota limits.'
        );
      } else if (
        requestBody.mediaType === MediaType.MOVIE &&
        quotas.movie.restricted
      ) {
        throw new QuotaRestrictedError('Movie Quota exceeded.');
      } else if (
        requestBody.mediaType === MediaType.TV &&
        quotas.tv.restricted
      ) {
        throw new QuotaRestrictedError('Series Quota exceeded.');
      }
    }

    const tmdbMedia =
      requestBody.mediaType === MediaType.MOVIE
        ? await tmdb.getMovie({ movieId: requestBody.mediaId })
        : await tmdb.getTvShow({ tvId: requestBody.mediaId });

    const isAutoRequest = options.isAutoRequest ?? false;
    const mediaIsAnime = isAnimeMedia(tmdbMedia);
    let resolvedEpisodeSelection: ResolvedEpisodeSelection | undefined;

    if (requestBody.episodeSelection !== undefined) {
      if (
        requestBody.mediaType !== MediaType.TV ||
        requestBody.seasons !== undefined
      ) {
        throw new InvalidEpisodeSelectionError(
          'Episode selections are only valid for TV requests and cannot be combined with seasons.'
        );
      }

      if (!episodeRequestsAvailable(settings, tmdbMedia)) {
        throw new EpisodeRequestsUnavailableError(
          'Episode requests require partial requests and the TVDB metadata provider.'
        );
      }

      try {
        const selection = parseEpisodeSelection(requestBody.episodeSelection);
        resolvedEpisodeSelection = await getResolvedTvdbEpisodeSelection({
          tvId: requestBody.mediaId,
          selection,
          allowSpecials: settings.main.enableSpecialEpisodes,
        });
      } catch (error) {
        throw new InvalidEpisodeSelectionError(
          error instanceof Error ? error.message : 'Invalid episode selection.'
        );
      }
    }

    let media = await mediaRepository.findOne({
      where: {
        tmdbId: requestBody.mediaId,
        mediaType: requestBody.mediaType,
      },
      relations: ['requests'],
    });

    if (!media) {
      media = new Media({
        tmdbId: tmdbMedia.id,
        tvdbId: requestBody.tvdbId ?? tmdbMedia.external_ids.tvdb_id,
        status: !requestBody.is4k ? MediaStatus.PENDING : MediaStatus.UNKNOWN,
        status4k: requestBody.is4k ? MediaStatus.PENDING : MediaStatus.UNKNOWN,
        mediaType: requestBody.mediaType,
      });
    } else {
      if (media.status === MediaStatus.BLOCKLISTED) {
        logger.warn('Request for media blocked due to being blocklisted', {
          tmdbId: tmdbMedia.id,
          mediaType: requestBody.mediaType,
          label: 'Media Request',
        });

        throw new BlocklistedMediaError('This media is blocklisted.');
      }

      if (
        (media.status === MediaStatus.UNKNOWN ||
          media.status === MediaStatus.DELETED) &&
        !requestBody.is4k
      ) {
        media.status = MediaStatus.PENDING;
      }

      if (
        (media.status4k === MediaStatus.UNKNOWN ||
          media.status4k === MediaStatus.DELETED) &&
        requestBody.is4k
      ) {
        media.status4k = MediaStatus.PENDING;
      }
    }

    const existing = await requestRepository
      .createQueryBuilder('request')
      .leftJoinAndSelect('request.media', 'media')
      .leftJoinAndSelect('request.requestedBy', 'user')
      .where('request.is4k = :is4k', { is4k: requestBody.is4k })
      .andWhere('media.tmdbId = :tmdbId', { tmdbId: tmdbMedia.id })
      .andWhere('media.mediaType = :mediaType', {
        mediaType: requestBody.mediaType,
      })
      .getMany();

    if (existing && existing.length > 0) {
      // If there is an existing movie request that isn't declined, don't allow a new one.
      if (
        requestBody.mediaType === MediaType.MOVIE &&
        existing[0].status !== MediaRequestStatus.DECLINED &&
        existing[0].status !== MediaRequestStatus.COMPLETED
      ) {
        logger.warn('Duplicate request for media blocked', {
          tmdbId: tmdbMedia.id,
          mediaType: requestBody.mediaType,
          is4k: requestBody.is4k,
          label: 'Media Request',
        });

        throw new DuplicateMediaRequestError(
          'Request for this media already exists.'
        );
      }

      // If an existing auto-request for this media exists from the same user,
      // don't allow a new one.
      const statusKey = requestBody.is4k ? 'status4k' : 'status';
      if (
        existing.find(
          (r) =>
            r.requestedBy.id === requestUser.id &&
            r.isAutoRequest &&
            r.media?.[statusKey] !== MediaStatus.DELETED
        )
      ) {
        throw new DuplicateMediaRequestError(
          'Auto-request for this media and user already exists.'
        );
      }
    }

    // Apply overrides if the user is not an admin or has the "advanced request" permission
    const useOverrides = !user.hasPermission([Permission.MANAGE_REQUESTS], {
      type: 'or',
    });

    let rootFolder = requestBody.rootFolder;
    let profileId = requestBody.profileId;
    let tags = requestBody.tags;

    if (useOverrides) {
      const defaultRadarrId = requestBody.is4k
        ? settings.radarr.findIndex((r) => r.is4k && r.isDefault)
        : settings.radarr.findIndex((r) => !r.is4k && r.isDefault);
      const defaultSonarrId = requestBody.is4k
        ? settings.sonarr.findIndex((s) => s.is4k && s.isDefault)
        : settings.sonarr.findIndex((s) => !s.is4k && s.isDefault);

      const overrideRuleRepository = getRepository(OverrideRule);
      const overrideRules = await overrideRuleRepository.find({
        where:
          requestBody.mediaType === MediaType.MOVIE
            ? { radarrServiceId: defaultRadarrId }
            : { sonarrServiceId: defaultSonarrId },
      });

      const appliedOverrideRules = overrideRules.filter((rule) => {
        // Skip override rules if the media is an anime TV show as anime TV
        // is handled by default and override rules do not explicitly include
        // the anime keyword
        if (
          requestBody.mediaType === MediaType.TV &&
          mediaIsAnime &&
          (!rule.keywords ||
            !rule.keywords.split(',').map(Number).includes(ANIME_KEYWORD_ID))
        ) {
          return false;
        }

        if (
          rule.users &&
          !rule.users
            .split(',')
            .some((userId) => Number(userId) === requestUser.id)
        ) {
          return false;
        }
        if (
          rule.genre &&
          !rule.genre
            .split(',')
            .some((genreId) =>
              tmdbMedia.genres
                .map((genre) => genre.id)
                .includes(Number(genreId))
            )
        ) {
          return false;
        }
        if (
          rule.language &&
          !rule.language
            .split('|')
            .some((languageId) => languageId === tmdbMedia.original_language)
        ) {
          return false;
        }
        if (
          rule.keywords &&
          !rule.keywords.split(',').some((keywordId) => {
            let keywordList: TmdbKeyword[] = [];

            if ('keywords' in tmdbMedia.keywords) {
              keywordList = tmdbMedia.keywords.keywords;
            } else if ('results' in tmdbMedia.keywords) {
              keywordList = tmdbMedia.keywords.results;
            }

            return keywordList
              .map((keyword: TmdbKeyword) => keyword.id)
              .includes(Number(keywordId));
          })
        ) {
          return false;
        }
        return true;
      });

      // Prefer the rule with the most explicitly scoped conditions.
      const prioritizedRule = appliedOverrideRules.sort((a, b) => {
        const keys: (keyof OverrideRule)[] = ['genre', 'language', 'keywords'];

        const aSpecificity = keys.filter((key) => a[key] !== null).length;
        const bSpecificity = keys.filter((key) => b[key] !== null).length;

        // Take the rule with the most specific condition first
        return bSpecificity - aSpecificity;
      })[0];

      if (prioritizedRule) {
        if (prioritizedRule.rootFolder) {
          rootFolder = prioritizedRule.rootFolder;
        }
        if (prioritizedRule.profileId) {
          profileId = prioritizedRule.profileId;
        }
        if (prioritizedRule.tags) {
          tags = [
            ...new Set([
              ...(tags || []),
              ...prioritizedRule.tags.split(',').map((tag) => Number(tag)),
            ]),
          ];
        }

        logger.debug('Override rule applied.', {
          label: 'Media Request',
          overrides: prioritizedRule,
        });
      }
    }

    const serverId = requestBody.serverId;
    const languageProfileId = requestBody.languageProfileId;

    const planInput: RequestPlanInput = {
      media,
      requestBody,
      requestUser,
      actor: user,
      serverId,
      profileId,
      rootFolder,
      languageProfileId,
      tags,
      isAutoRequest,
      ignoreQuota,
    };

    if (requestBody.mediaType === MediaType.MOVIE) {
      return MediaRequest.persistPlan(buildMovieRequestPlan(planInput));
    }

    if (resolvedEpisodeSelection) {
      const episodeSelection = resolvedEpisodeSelection;
      const createEpisodeRequest = async () => {
        const latestRequests = await requestRepository
          .createQueryBuilder('request')
          .leftJoinAndSelect('request.media', 'linkedMedia')
          .leftJoinAndSelect('request.seasons', 'seasons')
          .leftJoinAndSelect('request.episodes', 'episodes')
          .where('request.is4k = :is4k', { is4k: requestBody.is4k })
          .andWhere('linkedMedia.tmdbId = :tmdbId', { tmdbId: tmdbMedia.id })
          .andWhere('linkedMedia.mediaType = :mediaType', {
            mediaType: requestBody.mediaType,
          })
          .getMany();
        const activeRequests = latestRequests.filter(
          (request) =>
            request.status !== MediaRequestStatus.DECLINED &&
            request.status !== MediaRequestStatus.COMPLETED
        );
        const plan = buildEpisodeRequestPlan({
          input: planInput,
          selection: episodeSelection,
          activeRequests,
          quotas,
        });

        try {
          return await MediaRequest.persistPlan(plan);
        } catch (error) {
          if (
            episodeSelection.type === 'after' &&
            isOngoingEpisodeRequestConflict(error)
          ) {
            throw new DuplicateMediaRequestError(
              'An ongoing episode request already exists for this series.'
            );
          }
          throw error;
        }
      };

      if (resolvedEpisodeSelection.type === 'after') {
        return withOngoingEpisodeRequestLock(
          tmdbMedia.id,
          requestBody.is4k ?? false,
          createEpisodeRequest
        );
      }
      return createEpisodeRequest();
    }

    const tmdbMediaShow = tmdbMedia as Awaited<
      ReturnType<typeof tmdb.getTvShow>
    >;
    let requestedSeasons =
      requestBody.seasons === 'all'
        ? tmdbMediaShow.seasons
            .filter((season) => season.season_number !== 0)
            .map((season) => season.season_number)
        : (requestBody.seasons as number[]);
    if (!settings.main.enableSpecialEpisodes) {
      requestedSeasons = requestedSeasons.filter((season) => season > 0);
    }

    return MediaRequest.persistPlan(
      buildSeasonRequestPlan({ input: planInput, requestedSeasons, quotas })
    );
  }

  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'integer' })
  @Index()
  public status: MediaRequestStatus;

  @ManyToOne(() => Media, (media) => media.requests, {
    eager: true,
    onDelete: 'CASCADE',
  })
  @Index()
  public media: Media;

  @ManyToOne(() => User, (user) => user.requests, {
    eager: true,
    onDelete: 'CASCADE',
  })
  @Index()
  public requestedBy: User;

  @ManyToOne(() => User, {
    nullable: true,
    eager: true,
    onDelete: 'SET NULL',
  })
  @Index()
  public modifiedBy?: User;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  @Column({ type: 'varchar' })
  public type: MediaType;

  @RelationCount((request: MediaRequest) => request.seasons)
  public seasonCount: number;

  @OneToMany(() => SeasonRequest, (season) => season.request, {
    eager: true,
    cascade: true,
  })
  public seasons: SeasonRequest[];

  @OneToMany(() => EpisodeRequest, (episode) => episode.request, {
    eager: true,
    cascade: true,
  })
  public episodes: EpisodeRequest[];

  @Column({ type: 'varchar', nullable: true })
  public episodeSelectionType?: 'single' | 'range' | 'after';

  @Column({ nullable: true })
  public episodeStartTvdbId?: number;

  @Column({ nullable: true })
  public episodeEndTvdbId?: number;

  /**
   * Logical series/quality key protected by the active-ongoing partial index.
   */
  @Column({ type: 'varchar', nullable: true })
  public ongoingEpisodeRequestKey?: string;

  @Column({ type: 'int', default: 0 })
  public tvQuotaUnits: number;

  @Column({ default: false })
  public is4k: boolean;

  @Column({ nullable: true })
  public serverId: number;

  @Column({ nullable: true })
  public profileId: number;

  @Column({ nullable: true })
  public rootFolder: string;

  @Column({ nullable: true })
  public languageProfileId: number;

  @Column({
    type: 'text',
    nullable: true,
    transformer: {
      from: (value: string | null): number[] | null => {
        if (value) {
          if (value === 'none') {
            return [];
          }
          return value.split(',').map((v) => Number(v));
        }
        return null;
      },
      to: (value: number[] | null): string | null => {
        if (value) {
          const finalValue = value.join(',');

          // We want to keep the actual state of an "empty array" so we use
          // the keyword "none" to track this.
          if (!finalValue) {
            return 'none';
          }

          return finalValue;
        }
        return null;
      },
    },
  })
  public tags?: number[];

  @Column({ default: false })
  public isAutoRequest: boolean;

  @Column({ default: false })
  public ignoreQuota: boolean;

  constructor(init?: Partial<MediaRequest>) {
    Object.assign(this, init);
  }

  @AfterInsert()
  public async notifyNewRequest(): Promise<void> {
    if (this.status === MediaRequestStatus.PENDING) {
      const mediaRepository = getRepository(Media);
      const media = await mediaRepository.findOne({
        where: { id: this.media.id },
      });
      if (!media) {
        logger.error('Media data not found', {
          label: 'Media Request',
          requestId: this.id,
          mediaId: this.media.id,
        });
        return;
      }

      MediaRequest.sendNotification(this, media, Notification.MEDIA_PENDING);

      if (this.isAutoRequest) {
        MediaRequest.sendNotification(
          this,
          media,
          Notification.MEDIA_AUTO_REQUESTED
        );
      }
    }
  }

  /**
   * Notification for approval
   *
   * We only check on AfterUpdate as to not trigger this for
   * auto approved content
   */
  @AfterUpdate()
  public async notifyApprovedOrDeclined(autoApproved = false): Promise<void> {
    if (
      this.status === MediaRequestStatus.APPROVED ||
      this.status === MediaRequestStatus.DECLINED
    ) {
      const mediaRepository = getRepository(Media);
      const media = await mediaRepository.findOne({
        where: { id: this.media.id },
      });
      if (!media) {
        logger.error('Media data not found', {
          label: 'Media Request',
          requestId: this.id,
          mediaId: this.media.id,
        });
        return;
      }

      if (
        this.status === MediaRequestStatus.APPROVED &&
        media[this.is4k ? 'status4k' : 'status'] === MediaStatus.AVAILABLE
      ) {
        logger.info(
          'Media is already available. Sending availability notification instead of approval.',
          { label: 'Media Request', requestId: this.id, mediaId: this.media.id }
        );
        MediaRequest.sendNotification(
          this,
          media,
          Notification.MEDIA_AVAILABLE
        );
        return;
      }

      MediaRequest.sendNotification(
        this,
        media,
        this.status === MediaRequestStatus.APPROVED
          ? autoApproved
            ? Notification.MEDIA_AUTO_APPROVED
            : Notification.MEDIA_APPROVED
          : Notification.MEDIA_DECLINED
      );

      if (
        this.status === MediaRequestStatus.APPROVED &&
        autoApproved &&
        this.isAutoRequest
      ) {
        MediaRequest.sendNotification(
          this,
          media,
          Notification.MEDIA_AUTO_REQUESTED
        );
      }
    }
  }

  @AfterInsert()
  public async autoapprovalNotification(): Promise<void> {
    if (this.status === MediaRequestStatus.APPROVED) {
      this.notifyApprovedOrDeclined(true);
    }
  }

  @AfterLoad()
  private sortChildren() {
    if (Array.isArray(this.seasons)) {
      this.seasons.sort((a, b) => a.id - b.id);
    }
    if (Array.isArray(this.episodes)) {
      this.episodes.sort(
        (a, b) =>
          a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber
      );
    }
  }

  static async sendNotification(
    entity: MediaRequest,
    media: Media,
    type: Notification
  ) {
    const tmdb = new TheMovieDb();

    try {
      const mediaType = entity.type === MediaType.MOVIE ? 'Movie' : 'Series';
      let event: string | undefined;
      let notifyAdmin = true;
      let notifySystem = true;

      switch (type) {
        case Notification.MEDIA_AVAILABLE:
          event = `${entity.is4k ? '4K ' : ''}${mediaType} Now Available`;
          notifyAdmin = false;
          break;
        case Notification.MEDIA_APPROVED:
          event = `${entity.is4k ? '4K ' : ''}${mediaType} Request Approved`;
          notifyAdmin = false;
          break;
        case Notification.MEDIA_DECLINED:
          event = `${entity.is4k ? '4K ' : ''}${mediaType} Request Declined`;
          notifyAdmin = false;
          break;
        case Notification.MEDIA_PENDING:
          event = `New ${entity.is4k ? '4K ' : ''}${mediaType} Request`;
          break;
        case Notification.MEDIA_AUTO_REQUESTED:
          event = `${
            entity.is4k ? '4K ' : ''
          }${mediaType} Request Automatically Submitted`;
          notifyAdmin = false;
          notifySystem = false;
          break;
        case Notification.MEDIA_AUTO_APPROVED:
          event = `${
            entity.is4k ? '4K ' : ''
          }${mediaType} Request Automatically Approved`;
          break;
        case Notification.MEDIA_FAILED:
          event = `${entity.is4k ? '4K ' : ''}${mediaType} Request Failed`;
          break;
      }

      if (entity.type === MediaType.MOVIE) {
        const movie = await tmdb.getMovie({ movieId: media.tmdbId });
        notificationManager.sendNotification(type, {
          media,
          request: entity,
          notifyAdmin,
          notifySystem,
          notifyUser: notifyAdmin ? undefined : entity.requestedBy,
          event,
          subject: `${movie.title}${
            movie.release_date ? ` (${movie.release_date.slice(0, 4)})` : ''
          }`,
          message: truncate(movie.overview, {
            length: 500,
            separator: /\s/,
            omission: '…',
          }),
          image: `https://image.tmdb.org/t/p/w600_and_h900_bestv2${movie.poster_path}`,
        });
      } else if (entity.type === MediaType.TV) {
        const tv = await tmdb.getTvShow({ tvId: media.tmdbId });
        notificationManager.sendNotification(type, {
          media,
          request: entity,
          notifyAdmin,
          notifySystem,
          notifyUser: notifyAdmin ? undefined : entity.requestedBy,
          event,
          subject: `${tv.name}${
            tv.first_air_date ? ` (${tv.first_air_date.slice(0, 4)})` : ''
          }`,
          message: truncate(tv.overview, {
            length: 500,
            separator: /\s/,
            omission: '…',
          }),
          image: `https://image.tmdb.org/t/p/w600_and_h900_bestv2${tv.poster_path}`,
          extra: [
            entity.episodes?.length
              ? {
                  name: 'Requested Episodes',
                  value:
                    entity.episodeSelectionType === 'after'
                      ? `S${String(entity.episodes[0].seasonNumber).padStart(2, '0')}E${String(entity.episodes[0].episodeNumber).padStart(2, '0')} onward`
                      : entity.episodes
                          .map(
                            (episode) =>
                              `S${String(episode.seasonNumber).padStart(2, '0')}E${String(episode.episodeNumber).padStart(2, '0')}`
                          )
                          .join(', '),
                }
              : {
                  name: 'Requested Seasons',
                  value: entity.seasons
                    .map((season) => season.seasonNumber)
                    .join(', '),
                },
          ],
        });
      }
    } catch (e) {
      logger.error('Something went wrong sending media notification(s)', {
        label: 'Notifications',
        errorMessage: e.message,
        requestId: entity.id,
        mediaId: entity.media.id,
      });
    }
  }
}

export default MediaRequest;
