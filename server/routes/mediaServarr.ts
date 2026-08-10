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
import { isAuthenticated } from '@server/middleware/auth';
import { Router } from 'express';
import NodeCache from 'node-cache';
import { randomUUID } from 'node:crypto';

const mediaServarrRoutes = Router();
const tokens = new NodeCache({ stdTTL: 900, checkperiod: 120 });

type Context = {
  media: Media;
  is4k: boolean;
  type: 'radarr' | 'sonarr';
  externalId: number;
  client: RadarrAPI | SonarrAPI;
  serviceName: string;
};
type Token = {
  userId: number;
  mediaId: number;
  is4k: boolean;
  type: Context['type'];
  externalId: number;
  value: ServarrRelease | ManualImportCandidate | number;
};

const parseIs4k = (value: unknown) => value === 'true' || value === true;
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
    client: new SonarrAPI({
      apiKey: service.apiKey,
      url: SonarrAPI.buildUrl(service, '/api/v3'),
    }),
  };
}

function getToken(token: string, context: Context, userId: number): Token {
  const record = tokens.get<Token>(token);
  if (
    !record ||
    record.userId !== userId ||
    record.mediaId !== context.media.id ||
    record.is4k !== context.is4k ||
    record.type !== context.type ||
    record.externalId !== context.externalId
  ) {
    throw Object.assign(
      new Error('This operation has expired. Refresh and try again.'),
      { status: 409 }
    );
  }
  return record;
}

const protectedRoute = isAuthenticated(Permission.MANAGE_REQUESTS);

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
        });
      const series = await (context.client as SonarrAPI).getSeriesById(
        context.externalId
      );
      const episodes = await (context.client as SonarrAPI).getEpisodes(
        context.externalId
      );
      return res.json({
        mediaId: context.media.id,
        mediaType: 'tv',
        is4k: context.is4k,
        service: { type: context.type, name: context.serviceName },
        seasons: series.seasons.map((season) => ({
          ...season,
          episodes: episodes.filter(
            (episode) => episode.seasonNumber === season.seasonNumber
          ),
        })),
      });
    } catch (error) {
      next({
        status: (error as { status?: number }).status ?? 502,
        message: (error as Error).message,
      });
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
      if (context.type === 'radarr')
        releases = await (context.client as RadarrAPI).getMovieReleases(
          context.externalId
        );
      else if (
        req.query.target === 'episode' &&
        Number.isInteger(Number(req.query.episodeId))
      ) {
        const episodeId = Number(req.query.episodeId);
        const episode = (
          await (context.client as SonarrAPI).getEpisodes(context.externalId)
        ).find((item) => item.id === episodeId);
        if (!episode)
          throw Object.assign(
            new Error('Episode does not belong to this series.'),
            { status: 400 }
          );
        releases = await (context.client as SonarrAPI).getEpisodeReleases(
          episodeId
        );
      } else if (
        req.query.target === 'season' &&
        Number.isInteger(Number(req.query.seasonNumber))
      )
        releases = await (context.client as SonarrAPI).getSeasonReleases(
          context.externalId,
          Number(req.query.seasonNumber)
        );
      else
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
              value: release,
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
      next({
        status: (error as { status?: number }).status ?? 502,
        message: (error as Error).message,
      });
    }
  }
);

mediaServarrRoutes.post(
  '/:id/servarr/releases/grab',
  protectedRoute,
  async (req, res, next) => {
    try {
      const context = await resolveContext(
        Number(req.params.id),
        !!req.body.is4k
      );
      const record = getToken(req.body.token, context, req.user!.id);
      const release = record.value as ServarrRelease;
      if (!release.downloadAllowed)
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
      await context.client.grabRelease(release);
      tokens.del(req.body.token);
      return res.json({ accepted: true });
    } catch (error) {
      next({
        status: (error as { status?: number }).status ?? 502,
        message: (error as Error).message,
      });
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
      const client = context.client;
      const folderCandidates =
        context.type === 'radarr'
          ? await (client as RadarrAPI).getManualImportCandidates({
              movieId: context.externalId,
            })
          : await (client as SonarrAPI).getManualImportCandidates({
              seriesId: context.externalId,
            });
      const queue =
        context.type === 'radarr'
          ? await (client as RadarrAPI).getMovieQueueDetails(context.externalId)
          : await (client as SonarrAPI).getSeriesQueueDetails(
              context.externalId
            );
      const queueCandidates = await Promise.all(
        queue
          .filter((item) => item.downloadId && item.outputPath)
          .slice(0, 20)
          .map(async (item) => {
            const candidates =
              context.type === 'radarr'
                ? await (client as RadarrAPI).getManualImportCandidates({
                    movieId: context.externalId,
                    folder: item.outputPath,
                    downloadId: item.downloadId,
                  })
                : await (client as SonarrAPI).getManualImportCandidates({
                    seriesId: context.externalId,
                    folder: item.outputPath,
                    downloadId: item.downloadId,
                  });
            return candidates.map((candidate) => ({
              candidate,
              source: item.title,
            }));
          })
      );
      const seen = new Set<string>();
      const candidates = [
        ...queueCandidates
          .flat()
          .map(({ candidate, source }) => ({ candidate, source })),
        ...folderCandidates.map((candidate) => ({
          candidate,
          source: 'Media folder',
        })),
      ];
      return res.json({
        candidates: candidates
          .filter(
            ({ candidate }) =>
              !seen.has(candidate.path) && !!seen.add(candidate.path)
          )
          .map(({ candidate, source }) => ({
            token: tokenFor({
              userId: req.user!.id,
              mediaId: context.media.id,
              is4k: context.is4k,
              type: context.type,
              externalId: context.externalId,
              value: candidate,
            }),
            source,
            name: candidate.name,
            relativePath: candidate.relativePath,
            folderName: candidate.folderName,
            size: candidate.size,
            quality: (candidate.quality as { quality?: { name?: string } })
              ?.quality?.name,
            languages:
              candidate.languages
                ?.map((language) => (language as { name?: string }).name)
                .filter(Boolean) ?? [],
            rejections: candidate.rejections?.map((item) => item.reason) ?? [],
            episodes:
              (candidate as ManualImportCandidate & { episodes?: unknown[] })
                .episodes ?? [],
          })),
      });
    } catch (error) {
      next({
        status: (error as { status?: number }).status ?? 502,
        message: (error as Error).message,
      });
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
        !!req.body.is4k
      );
      const selected = Array.isArray(req.body.candidateTokens)
        ? req.body.candidateTokens
        : [];
      if (!selected.length || selected.length > 100)
        throw Object.assign(
          new Error('Select between one and 100 files to import.'),
          { status: 400 }
        );
      const files: ManualImportCandidate[] = selected.map(
        (token: string) =>
          getToken(token, context, req.user!.id).value as ManualImportCandidate
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
          (
            await (context.client as SonarrAPI).getEpisodes(context.externalId)
          ).map((episode) => episode.id)
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
            value: command.id,
          },
          3600
        ),
        status: command.status,
      });
    } catch (error) {
      next({
        status: (error as { status?: number }).status ?? 502,
        message: (error as Error).message,
      });
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
      const commandId = getToken(req.params.token, context, req.user!.id)
        .value as number;
      const command = await context.client.getCommand(commandId);
      return res.json({
        status: command.status?.toLowerCase() ?? 'unknown',
        message: command.message,
        queuedAt: command.queued,
        startedAt: command.started,
        endedAt: command.ended,
      });
    } catch (error) {
      next({
        status: (error as { status?: number }).status ?? 502,
        message: (error as Error).message,
      });
    }
  }
);

export default mediaServarrRoutes;
