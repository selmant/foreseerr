import type {
  QueueDetailsItem,
  ServarrGrabRequest,
} from '@server/api/servarr/base';
import RadarrAPI, {
  type ManualImportCandidate,
  type ServarrRelease,
} from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { Router } from 'express';
import NodeCache from 'node-cache';
import { randomUUID } from 'node:crypto';

const mediaServarrRoutes = Router();
/** Process-local operation tokens; see docs/servarr-interactive-operations.md */
const tokens = new NodeCache({ stdTTL: 900, checkperiod: 120 });

type ContextBase = {
  media: Media;
  is4k: boolean;
  externalId: number;
  serviceName: string;
  nativeUrl?: string;
};
/**
 * Keep the Arr client tied to the service type. The route used to carry a
 * broad client union and recover it with assertions at every destructive
 * operation, making a movie/series mix-up easy to introduce.
 */
type RadarrContext = ContextBase & {
  type: 'radarr';
  client: RadarrAPI;
};
type SonarrContext = ContextBase & {
  type: 'sonarr';
  client: SonarrAPI;
};
type Context = RadarrContext | SonarrContext;
type ImportSource = {
  kind: 'queue';
  label: string;
  folder: string;
  downloadId: string;
};
type ImportCandidate = {
  candidate: ManualImportCandidate;
  source: ImportSource;
};
type TokenBase = {
  userId: number;
  mediaId: number;
  is4k: boolean;
  type: Context['type'];
  externalId: number;
  episodeId?: number;
  seasonNumber?: number;
};
type ReleaseToken = TokenBase & { kind: 'release'; value: ServarrRelease };
type ImportSourceToken = TokenBase & {
  kind: 'import-source';
  value: ImportSource;
};
type ImportCandidateToken = TokenBase & {
  kind: 'import-candidate';
  value: ImportCandidate;
};
type CommandToken = TokenBase & { kind: 'command'; value: number };
type Token =
  | ReleaseToken
  | ImportSourceToken
  | ImportCandidateToken
  | CommandToken;
type TokenKind = Token['kind'];
type TokenByKind<K extends TokenKind> = Extract<Token, { kind: K }>;

const parseIs4k = (value: unknown) => value === 'true' || value === true;
const safeExternalUrl = (value?: string) => {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
};
const tokenFor = (record: Token, ttl = 900) => {
  const token = randomUUID();
  tokens.set(token, record, ttl);
  return token;
};

async function resolveContext(
  mediaId: number,
  is4k: boolean
): Promise<Context> {
  const media = await getRepository(Media).findOne({ where: { id: mediaId } });
  if (!media)
    throw Object.assign(new Error('Media does not exist.'), { status: 404 });
  const serviceId = media[is4k ? 'serviceId4k' : 'serviceId'];
  const externalId = media[is4k ? 'externalServiceId4k' : 'externalServiceId'];
  if (serviceId == null || externalId == null) {
    throw Object.assign(
      new Error('This media is not mapped to a Servarr instance.'),
      { status: 409 }
    );
  }
  const settings = getSettings();
  if (media.mediaType === MediaType.MOVIE) {
    const service = settings.radarr.find((item) => item.id === serviceId);
    if (!service)
      throw Object.assign(
        new Error('The mapped Radarr instance is no longer configured.'),
        { status: 409 }
      );
    return {
      media,
      is4k,
      type: 'radarr',
      externalId,
      serviceName: service.name,
      nativeUrl: safeExternalUrl(service.externalUrl),
      client: new RadarrAPI({
        apiKey: service.apiKey,
        url: RadarrAPI.buildUrl(service, '/api/v3'),
      }),
    };
  }
  const service = settings.sonarr.find((item) => item.id === serviceId);
  if (!service)
    throw Object.assign(
      new Error('The mapped Sonarr instance is no longer configured.'),
      { status: 409 }
    );
  return {
    media,
    is4k,
    type: 'sonarr',
    externalId,
    serviceName: service.name,
    nativeUrl: safeExternalUrl(service.externalUrl),
    client: new SonarrAPI({
      apiKey: service.apiKey,
      url: SonarrAPI.buildUrl(service, '/api/v3'),
    }),
  };
}

function getToken<K extends TokenKind>(
  token: string,
  context: Context,
  userId: number,
  kind: K
): TokenByKind<K> {
  const record = tokens.get<Token>(token);
  if (
    !record ||
    record.userId !== userId ||
    record.mediaId !== context.media.id ||
    record.is4k !== context.is4k ||
    record.type !== context.type ||
    record.externalId !== context.externalId ||
    (kind && record.kind !== kind)
  ) {
    throw Object.assign(
      new Error('This operation has expired. Refresh and try again.'),
      { status: 409 }
    );
  }
  return record as TokenByKind<K>;
}

const protectedRoute = isAuthenticated(Permission.MANAGE_REQUESTS);

function isCompleteImportCandidate(
  candidate: ManualImportCandidate,
  type: Context['type']
) {
  return type === 'radarr'
    ? !!candidate.movie && !!candidate.quality && !!candidate.languages?.length
    : !!candidate.series &&
        candidate.seasonNumber != null &&
        !!candidate.episodes?.length &&
        !!candidate.quality &&
        !!candidate.languages?.length;
}

export function isInteractiveImportQueueItem(item: QueueDetailsItem) {
  return (
    item.status?.toLowerCase() === 'completed' &&
    item.trackedDownloadStatus?.toLowerCase() === 'warning' &&
    !!item.downloadId &&
    !!item.outputPath
  );
}

export function canGrabRelease(release: ServarrRelease) {
  return (
    release.downloadAllowed || release.rejected || release.temporarilyRejected
  );
}

export function releaseGrabRequest(options: {
  release: ServarrRelease;
  type: Context['type'];
  externalId: number;
  episodeIds?: number[];
  acknowledgeRejections: boolean;
}): ServarrGrabRequest {
  const request: ServarrGrabRequest = {
    guid: options.release.guid,
    indexerId: options.release.indexerId,
  };
  if (options.type === 'sonarr') request.seriesId = options.externalId;
  else request.movieId = options.externalId;

  const episodeIds = options.episodeIds?.length
    ? options.episodeIds
    : (options.release.mappedEpisodeInfo?.map((episode) => episode.id) ??
      options.release.episodeIds ??
      (options.release.episodeId != null
        ? [options.release.episodeId]
        : undefined));

  if (
    options.acknowledgeRejections &&
    options.release.quality &&
    options.release.languages &&
    (options.type === 'radarr' || Boolean(episodeIds?.length))
  ) {
    request.shouldOverride = true;
    request.quality = options.release.quality;
    request.languages = options.release.languages;
    if (options.type === 'sonarr') request.episodeIds = episodeIds;
  }

  return request;
}

export function routeError(error: unknown, fallback = 502) {
  const assigned = error as {
    status?: number;
    message?: string;
    response?: { status?: number; data?: { message?: string } | string };
  };
  if (assigned.status && !assigned.response) {
    return {
      status: assigned.status,
      message: assigned.message ?? 'Request failed.',
    };
  }
  const data = assigned.response?.data;
  const message =
    (typeof data === 'string' && data) ||
    (typeof data === 'object' && data?.message) ||
    assigned.message ||
    'Servarr request failed.';
  return {
    status: assigned.response?.status ?? fallback,
    message,
  };
}

export function episodeQueueStatus(item: QueueDetailsItem) {
  const status = item.status?.toLowerCase();
  if (status === 'completed' && item.trackedDownloadStatus === 'warning')
    return 'manual-import' as const;
  if (status === 'importing') return 'importing' as const;
  if (status === 'downloading') return 'downloading' as const;
  if (['queued', 'paused', 'delay'].includes(status ?? ''))
    return 'queued' as const;
  return undefined;
}

function importSourceFor(item: QueueDetailsItem): ImportSource {
  return {
    kind: 'queue',
    label: item.title,
    folder: item.outputPath!,
    downloadId: item.downloadId!,
  };
}

async function getImportQueue(context: Context): Promise<QueueDetailsItem[]> {
  if (context.type === 'radarr') {
    return context.client.getMovieQueueDetails(context.externalId);
  }
  return context.client.getSeriesQueueDetails(context.externalId);
}

async function assertCurrentImportSource(
  context: Context,
  source: ImportSource
) {
  const queue = await getImportQueue(context);
  const current = queue.find(
    (item) =>
      item.downloadId === source.downloadId && item.outputPath === source.folder
  );
  if (!current || !isInteractiveImportQueueItem(current))
    throw Object.assign(
      new Error(
        'This download no longer requires manual import. Refresh and try again.'
      ),
      { status: 409 }
    );
}

function candidateResponse(
  candidate: ManualImportCandidate,
  context: Context,
  userId: number,
  source: ImportSource
) {
  const episodes = candidate.episodes ?? [];
  const complete = isCompleteImportCandidate(candidate, context.type);
  return {
    token: tokenFor({
      userId,
      mediaId: context.media.id,
      is4k: context.is4k,
      type: context.type,
      externalId: context.externalId,
      kind: 'import-candidate',
      value: { candidate, source },
    }),
    source: source.label,
    name: candidate.name,
    relativePath: candidate.relativePath,
    folderName: candidate.folderName,
    size: candidate.size,
    quality: (candidate.quality as { quality?: { name?: string } })?.quality
      ?.name,
    languages:
      candidate.languages?.map((language) => language.name).filter(Boolean) ??
      [],
    releaseGroup: candidate.releaseGroup,
    customFormats: candidate.customFormats?.map((format) => format.name) ?? [],
    customFormatScore: candidate.customFormatScore,
    rejections: candidate.rejections ?? [],
    seasonNumber: candidate.seasonNumber,
    episodes,
    complete,
  };
}

mediaServarrRoutes.get(
  '/:id/servarr/context',
  protectedRoute,
  async (req, res, next) => {
    try {
      const context = await resolveContext(
        Number(req.params.id),
        parseIs4k(req.query.is4k)
      );
      if (context.type === 'radarr')
        return res.json({
          mediaId: context.media.id,
          mediaType: 'movie',
          is4k: context.is4k,
          service: { type: context.type, name: context.serviceName },
          nativeUrl: context.nativeUrl,
        });
      const sonarr = context.client;
      const [series, episodes, queue] = await Promise.all([
        sonarr.getSeriesById(context.externalId),
        sonarr.getEpisodes(context.externalId),
        sonarr.getSeriesQueue(context.externalId),
      ]);
      const queueStatusByEpisodeId = new Map(
        queue
          .map((item) =>
            item.episode?.id
              ? ([item.episode.id, episodeQueueStatus(item)] as const)
              : undefined
          )
          .filter(
            (
              entry
            ): entry is readonly [
              number,
              ReturnType<typeof episodeQueueStatus>,
            ] => entry !== undefined
          )
      );
      return res.json({
        mediaId: context.media.id,
        mediaType: 'tv',
        is4k: context.is4k,
        service: { type: context.type, name: context.serviceName },
        nativeUrl: context.nativeUrl,
        seasons: series.seasons.map((season) => ({
          ...season,
          episodes: episodes
            .filter((episode) => episode.seasonNumber === season.seasonNumber)
            .map((episode) => ({
              ...episode,
              queueStatus: queueStatusByEpisodeId.get(episode.id),
            })),
        })),
      });
    } catch (error) {
      next(routeError(error));
    }
  }
);

mediaServarrRoutes.get(
  '/:id/servarr/releases',
  protectedRoute,
  async (req, res, next) => {
    try {
      const context = await resolveContext(
        Number(req.params.id),
        parseIs4k(req.query.is4k)
      );
      let releases: ServarrRelease[];
      let episodeId: number | undefined;
      let seasonNumber: number | undefined;
      if (context.type === 'radarr')
        releases = await context.client.getMovieReleases(context.externalId);
      else if (
        req.query.target === 'episode' &&
        Number.isInteger(Number(req.query.episodeId))
      ) {
        episodeId = Number(req.query.episodeId);
        const episode = (
          await context.client.getEpisodes(context.externalId)
        ).find((item) => item.id === episodeId);
        if (!episode)
          throw Object.assign(
            new Error('Episode does not belong to this series.'),
            { status: 400 }
          );
        releases = await context.client.getEpisodeReleases(episodeId);
      } else if (
        req.query.target === 'season' &&
        Number.isInteger(Number(req.query.seasonNumber))
      ) {
        seasonNumber = Number(req.query.seasonNumber);
        releases = await context.client.getSeasonReleases(
          context.externalId,
          seasonNumber
        );
      } else
        throw Object.assign(
          new Error('Select an episode or season to search.'),
          { status: 400 }
        );
      return res.json({
        results: releases.map((release) => ({
          token: tokenFor(
            {
              userId: req.user!.id,
              mediaId: context.media.id,
              is4k: context.is4k,
              type: context.type,
              externalId: context.externalId,
              kind: 'release',
              value: release,
              episodeId,
              seasonNumber,
            },
            1500
          ),
          title: release.title,
          quality: release.quality?.quality?.name,
          size: release.size,
          ageHours: release.ageHours,
          indexer: release.indexer,
          protocol: release.protocol,
          seeders: release.seeders,
          rejections: release.rejections ?? [],
          rejected: release.rejected || release.temporarilyRejected,
          downloadAllowed: release.downloadAllowed,
        })),
      });
    } catch (error) {
      next(routeError(error));
    }
  }
);

mediaServarrRoutes.post(
  '/:id/servarr/releases',
  protectedRoute,
  async (req, res, next) => {
    try {
      const context = await resolveContext(
        Number(req.params.id),
        parseIs4k(req.body.is4k)
      );
      const record = getToken(req.body.token, context, req.user!.id, 'release');
      const release = record.value;
      if (!canGrabRelease(release))
        throw Object.assign(
          new Error(
            'This release cannot be downloaded by the configured client.'
          ),
          { status: 409 }
        );
      if (
        (release.rejected || release.temporarilyRejected) &&
        !req.body.acknowledgeRejections
      )
        throw Object.assign(
          new Error('Confirm the release rejection warnings before grabbing.'),
          { status: 409 }
        );
      const acknowledgeRejections = Boolean(req.body.acknowledgeRejections);
      let episodeIds: number[] | undefined;
      if (context.type === 'sonarr' && acknowledgeRejections) {
        if (record.episodeId != null) episodeIds = [record.episodeId];
        else {
          const seasonNumber = record.seasonNumber ?? release.seasonNumber;
          const episodes = await context.client.getEpisodes(context.externalId);
          episodeIds = episodes
            .filter((episode) =>
              seasonNumber == null
                ? episode.seasonNumber > 0
                : episode.seasonNumber === seasonNumber
            )
            .map((episode) => episode.id);
        }
      }
      const grab = releaseGrabRequest({
        release,
        type: context.type,
        externalId: context.externalId,
        episodeIds,
        acknowledgeRejections,
      });
      logger.info('Grabbing Servarr release', {
        label: 'Servarr',
        mediaId: context.media.id,
        title: release.title,
        seriesId: grab.seriesId,
        movieId: grab.movieId,
        shouldOverride: grab.shouldOverride === true,
        rejections: release.rejections,
      });
      try {
        await context.client.grabRelease(grab);
      } catch (error) {
        logger.error('Servarr rejected the release grab', {
          label: 'Servarr',
          mediaId: context.media.id,
          title: release.title,
          errorMessage: routeError(error).message,
        });
        throw error;
      }
      tokens.del(req.body.token);
      return res.json({ accepted: true });
    } catch (error) {
      next(routeError(error));
    }
  }
);

mediaServarrRoutes.get(
  '/:id/servarr/imports/sources',
  protectedRoute,
  async (req, res, next) => {
    try {
      const context = await resolveContext(
        Number(req.params.id),
        parseIs4k(req.query.is4k)
      );
      const sources = (await getImportQueue(context))
        .filter(isInteractiveImportQueueItem)
        .slice(0, 20)
        .map(importSourceFor);
      return res.json({
        nativeUrl: context.nativeUrl,
        sources: sources.map((source) => ({
          token: tokenFor({
            userId: req.user!.id,
            mediaId: context.media.id,
            is4k: context.is4k,
            type: context.type,
            externalId: context.externalId,
            kind: 'import-source',
            value: source,
          }),
          kind: source.kind,
          label: source.label,
        })),
      });
    } catch (error) {
      next(routeError(error));
    }
  }
);

mediaServarrRoutes.post(
  '/:id/servarr/imports/scan',
  protectedRoute,
  async (req, res, next) => {
    try {
      if (
        typeof req.body.sourceToken !== 'string' ||
        req.body.sourceToken.length > 128
      )
        throw Object.assign(new Error('Choose an import source.'), {
          status: 400,
        });
      const context = await resolveContext(
        Number(req.params.id),
        parseIs4k(req.body.is4k)
      );
      const source = getToken(
        req.body.sourceToken,
        context,
        req.user!.id,
        'import-source'
      ).value;
      await assertCurrentImportSource(context, source);
      const candidates =
        context.type === 'radarr'
          ? await context.client.getManualImportCandidates({
              folder: source.folder,
              downloadId: source.downloadId,
            })
          : await context.client.getManualImportCandidates({
              folder: source.folder,
              downloadId: source.downloadId,
            });
      return res.json({
        source: source.label,
        candidates: candidates.map((candidate) =>
          candidateResponse(candidate, context, req.user!.id, source)
        ),
      });
    } catch (error) {
      logger.error('Servarr manual import scan failed', {
        label: 'Servarr',
        errorMessage: routeError(error).message,
      });
      next(routeError(error));
    }
  }
);

mediaServarrRoutes.post(
  '/:id/servarr/imports/reprocess',
  protectedRoute,
  async (req, res, next) => {
    try {
      if (
        typeof req.body.candidateToken !== 'string' ||
        req.body.candidateToken.length > 128 ||
        !Array.isArray(req.body.episodeIds) ||
        !req.body.episodeIds.length ||
        req.body.episodeIds.length > 100 ||
        req.body.episodeIds.some((id: unknown) => !Number.isInteger(id))
      )
        throw Object.assign(new Error('Choose valid episodes to rematch.'), {
          status: 400,
        });
      const context = await resolveContext(
        Number(req.params.id),
        parseIs4k(req.body.is4k)
      );
      if (context.type !== 'sonarr')
        throw Object.assign(
          new Error('Episode rematching is only available for Sonarr.'),
          { status: 400 }
        );
      const importCandidate = getToken(
        req.body.candidateToken,
        context,
        req.user!.id,
        'import-candidate'
      ).value;
      await assertCurrentImportSource(context, importCandidate.source);
      const validEpisodes = new Set(
        (await context.client.getEpisodes(context.externalId)).map(
          (episode) => episode.id
        )
      );
      const episodeIds = [...new Set(req.body.episodeIds as number[])];
      if (episodeIds.some((id) => !validEpisodes.has(id)))
        throw Object.assign(
          new Error('Every selected episode must belong to this series.'),
          { status: 400 }
        );
      const [reprocessed] =
        await context.client.reprocessManualImportCandidates([
          {
            ...importCandidate.candidate,
            seriesId: context.externalId,
            episodeIds,
          },
        ]);
      if (!reprocessed)
        throw Object.assign(
          new Error('Sonarr did not return a rematched import candidate.'),
          { status: 502 }
        );
      tokens.del(req.body.candidateToken);
      return res.json(
        candidateResponse(
          reprocessed,
          context,
          req.user!.id,
          importCandidate.source
        )
      );
    } catch (error) {
      next(routeError(error));
    }
  }
);

mediaServarrRoutes.get(
  '/:id/servarr/imports',
  protectedRoute,
  async (req, res, next) => {
    try {
      const context = await resolveContext(
        Number(req.params.id),
        parseIs4k(req.query.is4k)
      );
      const sources = (await getImportQueue(context))
        .filter(isInteractiveImportQueueItem)
        .slice(0, 20)
        .map(importSourceFor);
      const queueCandidates = await Promise.all(
        sources.map(async (source) => {
          const candidates =
            context.type === 'radarr'
              ? await context.client.getManualImportCandidates({
                  folder: source.folder,
                  downloadId: source.downloadId,
                })
              : await context.client.getManualImportCandidates({
                  folder: source.folder,
                  downloadId: source.downloadId,
                });
          return candidates.map((candidate) => ({
            candidate,
            source,
          }));
        })
      );
      const seen = new Set<string>();
      const candidates = queueCandidates.flat();
      return res.json({
        candidates: candidates
          .filter(
            ({ candidate }) =>
              !seen.has(candidate.path) && !!seen.add(candidate.path)
          )
          .map(({ candidate, source }) =>
            candidateResponse(candidate, context, req.user!.id, source)
          ),
      });
    } catch (error) {
      next(routeError(error));
    }
  }
);

mediaServarrRoutes.post(
  '/:id/servarr/imports',
  protectedRoute,
  async (req, res, next) => {
    try {
      const context = await resolveContext(
        Number(req.params.id),
        parseIs4k(req.body.is4k)
      );
      const selected = Array.isArray(req.body.candidateTokens)
        ? req.body.candidateTokens
        : [];
      if (
        !selected.length ||
        selected.length > 100 ||
        selected.some(
          (token: unknown) =>
            typeof token !== 'string' ||
            token.length === 0 ||
            token.length > 128
        )
      )
        throw Object.assign(
          new Error('Select between one and 100 files to import.'),
          { status: 400 }
        );
      const importCandidates: ImportCandidate[] = selected.map(
        (token: string) =>
          getToken(token, context, req.user!.id, 'import-candidate').value
      );
      await Promise.all(
        importCandidates.map(({ source }) =>
          assertCurrentImportSource(context, source)
        )
      );
      const files = importCandidates.map(({ candidate }) => ({ ...candidate }));
      if (files.some((file) => !isCompleteImportCandidate(file, context.type)))
        throw Object.assign(
          new Error(
            'One or more files need additional Arr metadata before importing.'
          ),
          { status: 409 }
        );
      if (
        files.some((file) => file.rejections?.length) &&
        !req.body.acknowledgeRejections
      )
        throw Object.assign(
          new Error('Confirm import rejection warnings before importing.'),
          { status: 409 }
        );
      const mappings = new Map<string, number[]>(
        (req.body.episodeMappings ?? []).map(
          (item: { candidateToken: string; episodeIds: number[] }) => [
            item.candidateToken,
            item.episodeIds,
          ]
        )
      );
      if (context.type === 'radarr')
        files.forEach((file) => {
          Object.assign(file, { movieId: context.externalId });
        });
      else {
        const valid = new Set(
          (await context.client.getEpisodes(context.externalId)).map(
            (episode) => episode.id
          )
        );
        files.forEach((file, index) => {
          const ids =
            mappings.get(selected[index]) ??
            (
              file as ManualImportCandidate & { episodes?: { id: number }[] }
            ).episodes?.map((episode) => episode.id) ??
            [];
          if (!ids.length || ids.some((id) => !valid.has(id)))
            throw Object.assign(
              new Error('Choose valid episodes for every selected file.'),
              { status: 400 }
            );
          Object.assign(file, {
            seriesId: context.externalId,
            episodeIds: [...new Set(ids)],
          });
        });
      }
      const command = await context.client.manualImport(
        files,
        req.body.importMode === 'copy' ? 'copy' : 'move'
      );
      selected.forEach((token: string) => tokens.del(token));
      return res.status(202).json({
        accepted: true,
        commandToken: tokenFor(
          {
            userId: req.user!.id,
            mediaId: context.media.id,
            is4k: context.is4k,
            type: context.type,
            externalId: context.externalId,
            kind: 'command',
            value: command.id,
          },
          3600
        ),
        status: command.status,
      });
    } catch (error) {
      next(routeError(error));
    }
  }
);

mediaServarrRoutes.get(
  '/:id/servarr/commands/:token',
  protectedRoute,
  async (req, res, next) => {
    try {
      const context = await resolveContext(
        Number(req.params.id),
        parseIs4k(req.query.is4k)
      );
      const commandId = getToken(
        req.params.token,
        context,
        req.user!.id,
        'command'
      ).value;
      const command = await context.client.getCommand(commandId);
      return res.json({
        status: command.status?.toLowerCase() ?? 'unknown',
        message: command.message,
        queuedAt: command.queued,
        startedAt: command.started,
        endedAt: command.ended,
      });
    } catch (error) {
      next(routeError(error));
    }
  }
);

export default mediaServarrRoutes;
