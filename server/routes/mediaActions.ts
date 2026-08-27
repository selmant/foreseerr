import {
  classifyWriteOutcome,
  getMediaActionCapabilities,
  getMediaActionDispatcher,
  writeHttpStatus,
  type MediaActionAggregate,
  type MediaActionMediaType,
  type MediaActionProviderResult,
  type MediaItemRef,
} from '@server/lib/mediaActions';
import { anilistEpisodeActions } from '@server/lib/mediaActions/anilistEpisodes';
import {
  episodeWriteAggregate,
  episodeWriteResult,
} from '@server/lib/mediaActions/episodeWrite';
import { jellyfinEpisodeActions } from '@server/lib/mediaActions/jellyfin';
import { simklEpisodeActions } from '@server/lib/mediaActions/simklEpisodes';
import { traktEpisodeActions } from '@server/lib/mediaActions/traktEpisodes';
import logger from '@server/logger';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

export const STATUS_BATCH_MAX_ITEMS = 100;

const mediaActionsRoutes = Router();

const positiveIdSchema = z.coerce.number().int().positive().max(2_147_483_647);
const episodeCoordinateSchema = z.coerce.number().int().min(0).max(10_000);
const jellyfinItemIdSchema = z.string().trim().min(1).max(255);

function parseMediaType(value: string): MediaActionMediaType | null {
  if (value === 'movie' || value === 'tv') {
    return value;
  }
  return null;
}

function parseTmdbId(value: string): number | null {
  const id = Number(value);
  if (!Number.isFinite(id) || id <= 0) {
    return null;
  }
  return Math.trunc(id);
}

function dedupeMediaItems(items: MediaItemRef[]): MediaItemRef[] {
  const seen = new Set<string>();
  const deduped: MediaItemRef[] = [];
  for (const item of items) {
    const key = `${item.mediaType}:${item.tmdbId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function parseItem(
  mediaTypeRaw: string,
  tmdbIdRaw: string
): MediaItemRef | { error: string } {
  const mediaType = parseMediaType(mediaTypeRaw);
  if (!mediaType) {
    return { error: 'mediaType must be movie or tv' };
  }
  const tmdbId = parseTmdbId(tmdbIdRaw);
  if (tmdbId == null) {
    return { error: 'tmdbId must be a positive number' };
  }
  return { mediaType, tmdbId };
}

function toResponse(result: MediaActionAggregate, includeOutcome = false) {
  const body: Record<string, unknown> = {
    tmdbId: result.tmdbId,
    mediaType: result.mediaType,
    watched: result.watched,
    rating: result.rating,
    ratingStars: result.ratingStars,
    actions: result.actions,
    providers: result.providers.map((p) => ({
      provider: p.provider,
      ok: p.ok,
      watched: p.watched,
      rating: p.rating,
      ratingStars: p.ratingStars,
      error: p.error,
    })),
  };
  if (includeOutcome) {
    body.outcome = result.outcome ?? classifyWriteOutcome(result);
  }
  return body;
}

function respondWrite(
  res: {
    status: (code: number) => { json: (body: unknown) => unknown };
  },
  result: MediaActionAggregate
) {
  const outcome = classifyWriteOutcome(result);
  const status = writeHttpStatus(outcome);
  return res.status(status).json(toResponse({ ...result, outcome }, true));
}

function handleActionError(
  e: unknown,
  next: (err?: unknown) => void,
  fallbackMessage: string
) {
  if (e instanceof Error && e.message.startsWith('ratingStars must be')) {
    return next({ status: 400, message: e.message });
  }
  logger.error(fallbackMessage, {
    label: 'API',
    errorMessage: e instanceof Error ? e.message : 'unknown error',
  });
  return next({ status: 500, message: fallbackMessage });
}

function parseEpisodePath(
  params: Record<string, unknown>
):
  | { tmdbId: number; seasonNumber: number; episodeNumber?: number }
  | { error: string } {
  const tmdbId = positiveIdSchema.safeParse(params.tmdbId);
  const seasonNumber = episodeCoordinateSchema.safeParse(params.seasonNumber);
  const episodeNumber =
    params.episodeNumber === undefined
      ? undefined
      : episodeCoordinateSchema.safeParse(params.episodeNumber);
  if (
    !tmdbId.success ||
    !seasonNumber.success ||
    (episodeNumber !== undefined && !episodeNumber.success)
  ) {
    return { error: 'Invalid episode identifiers.' };
  }
  return {
    tmdbId: tmdbId.data,
    seasonNumber: seasonNumber.data,
    ...(episodeNumber ? { episodeNumber: episodeNumber.data } : {}),
  };
}

mediaActionsRoutes.get('/capabilities', async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return next({ status: 401, message: 'Unauthorized' });
    }

    const capabilities = await getMediaActionCapabilities(req.user.id);
    return res.status(200).json(capabilities);
  } catch (error) {
    return handleActionError(
      error,
      next,
      'Unable to retrieve media action capabilities.'
    );
  }
});

mediaActionsRoutes.get(
  '/tv/:tmdbId/seasons/:seasonNumber/episodes/status',
  async (req, res, next) => {
    try {
      if (!req.user?.id) {
        return next({ status: 401, message: 'Unauthorized' });
      }
      const parsed = parseEpisodePath(req.params);
      if ('error' in parsed) {
        return next({ status: 400, message: parsed.error });
      }
      const [traktStatus, jellyfinStatus, anilistStatus, simklStatus] =
        await Promise.all([
          traktEpisodeActions.getSeasonStatus(
            req.user.id,
            parsed.tmdbId,
            parsed.seasonNumber
          ),
          jellyfinEpisodeActions.getSeasonStatus(
            req.user.id,
            parsed.tmdbId,
            parsed.seasonNumber
          ),
          anilistEpisodeActions.getSeasonStatus(
            req.user.id,
            parsed.tmdbId,
            parsed.seasonNumber
          ),
          simklEpisodeActions.getSeasonStatus(
            req.user.id,
            parsed.tmdbId,
            parsed.seasonNumber
          ),
        ]);

      const allWatched = new Set<number>();
      for (const ep of traktStatus.watchedEpisodeNumbers) {
        allWatched.add(ep);
      }
      for (const ep of jellyfinStatus.watchedEpisodeNumbers) {
        allWatched.add(ep);
      }
      for (const ep of anilistStatus.watchedEpisodeNumbers) {
        allWatched.add(ep);
      }
      for (const ep of simklStatus.watchedEpisodeNumbers) allWatched.add(ep);

      return res.status(200).json({
        available:
          traktStatus.available ||
          jellyfinStatus.available ||
          anilistStatus.available ||
          simklStatus.available,
        watchedEpisodeNumbers: Array.from(allWatched).sort((a, b) => a - b),
      });
    } catch (error) {
      return handleActionError(
        error,
        next,
        'Unable to retrieve episode watch status.'
      );
    }
  }
);

const setEpisodeWatched =
  (watched: boolean): RequestHandler =>
  async (req, res, next) => {
    try {
      if (!req.user?.id) {
        return next({ status: 401, message: 'Unauthorized' });
      }
      const parsed = parseEpisodePath(req.params);
      if ('error' in parsed || parsed.episodeNumber === undefined) {
        return next({ status: 400, message: 'Invalid episode identifiers.' });
      }

      const [
        traktAvailable,
        jellyfinAvailable,
        anilistAvailable,
        simklAvailable,
      ] = await Promise.all([
        traktEpisodeActions.isAvailable(req.user.id),
        jellyfinEpisodeActions.isAvailable(req.user.id),
        anilistEpisodeActions.isAvailable(req.user.id),
        simklEpisodeActions.isAvailable(req.user.id),
      ]);
      const directJellyfinItem = jellyfinItemIdSchema.safeParse(
        req.body?.jellyfinItemId
      );
      const actions: Promise<MediaActionProviderResult | null>[] = [];
      if (traktAvailable) {
        actions.push(
          episodeWriteResult(
            'trakt',
            watched,
            traktEpisodeActions.setWatched(
              req.user.id,
              parsed.tmdbId,
              parsed.seasonNumber,
              parsed.episodeNumber,
              watched
            )
          )
        );
      }
      if (jellyfinAvailable) {
        actions.push(
          episodeWriteResult(
            'jellyfin',
            watched,
            directJellyfinItem.success
              ? jellyfinEpisodeActions.setItemWatched(
                  req.user.id,
                  directJellyfinItem.data,
                  watched
                )
              : jellyfinEpisodeActions.setEpisodeWatched(
                  req.user.id,
                  parsed.tmdbId,
                  parsed.seasonNumber,
                  parsed.episodeNumber,
                  watched
                )
          )
        );
      }
      if (anilistAvailable) {
        actions.push(
          episodeWriteResult(
            'anilist',
            watched,
            anilistEpisodeActions.setWatched(
              req.user.id,
              parsed.tmdbId,
              parsed.seasonNumber,
              parsed.episodeNumber,
              watched
            )
          )
        );
      }
      if (simklAvailable) {
        actions.push(
          episodeWriteResult(
            'simkl',
            watched,
            simklEpisodeActions.setWatched(
              req.user.id,
              parsed.tmdbId,
              parsed.seasonNumber,
              parsed.episodeNumber,
              watched
            )
          )
        );
      }
      const providers = (await Promise.all(actions)).filter(
        (result): result is MediaActionProviderResult => result != null
      );
      const aggregate = episodeWriteAggregate(
        parsed.tmdbId,
        watched,
        providers
      );
      const outcome = classifyWriteOutcome(aggregate);

      return res
        .status(writeHttpStatus(outcome))
        .json(toResponse({ ...aggregate, outcome }, true));
    } catch (error) {
      return handleActionError(
        error,
        next,
        watched
          ? 'Unable to mark episode as watched.'
          : 'Unable to mark episode as unwatched.'
      );
    }
  };

mediaActionsRoutes.post(
  '/tv/:tmdbId/seasons/:seasonNumber/episodes/:episodeNumber/watched',
  setEpisodeWatched(true)
);

mediaActionsRoutes.post(
  '/tv/:tmdbId/seasons/:seasonNumber/episodes/:episodeNumber/unwatched',
  setEpisodeWatched(false)
);

const setJellyfinItemWatched =
  (watched: boolean): RequestHandler =>
  async (req, res, next) => {
    try {
      if (!req.user?.id) {
        return next({ status: 401, message: 'Unauthorized' });
      }
      const jellyfinItemId = jellyfinItemIdSchema.safeParse(
        req.params.jellyfinItemId
      );
      if (!jellyfinItemId.success) {
        return next({
          status: 400,
          message: 'Invalid Jellyfin item identifier.',
        });
      }

      const available = await jellyfinEpisodeActions.isAvailable(req.user.id);
      const ok = available
        ? await jellyfinEpisodeActions.setItemWatched(
            req.user.id,
            jellyfinItemId.data,
            watched
          )
        : false;
      const providers: MediaActionProviderResult[] = available
        ? [
            {
              provider: 'jellyfin',
              ok,
              watched: ok ? watched : !watched,
              rating: null,
              ratingStars: null,
              ...(ok ? {} : { error: 'Jellyfin episode item is unavailable' }),
            },
          ]
        : [];
      const aggregate = episodeWriteAggregate(0, watched, providers);
      const outcome = classifyWriteOutcome(aggregate);
      return res
        .status(writeHttpStatus(outcome))
        .json(toResponse({ ...aggregate, outcome }, true));
    } catch (error) {
      return handleActionError(
        error,
        next,
        watched
          ? 'Unable to mark Jellyfin episode as watched.'
          : 'Unable to mark Jellyfin episode as unwatched.'
      );
    }
  };

mediaActionsRoutes.post(
  '/episodes/jellyfin/:jellyfinItemId/watched',
  setJellyfinItemWatched(true)
);

mediaActionsRoutes.post(
  '/episodes/jellyfin/:jellyfinItemId/unwatched',
  setJellyfinItemWatched(false)
);

mediaActionsRoutes.get('/:mediaType/:tmdbId/status', async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return next({ status: 401, message: 'Unauthorized' });
    }
    const item = parseItem(req.params.mediaType, req.params.tmdbId);
    if ('error' in item) {
      return next({ status: 400, message: item.error });
    }

    const result = await getMediaActionDispatcher().getStatus(
      req.user.id,
      item
    );
    return res.status(200).json(toResponse(result));
  } catch (e) {
    return handleActionError(
      e,
      next,
      'Unable to retrieve media action status.'
    );
  }
});

mediaActionsRoutes.post('/status-batch', async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return next({ status: 401, message: 'Unauthorized' });
    }

    const rawItems = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!rawItems) {
      return next({ status: 400, message: 'items array is required' });
    }
    if (rawItems.length > STATUS_BATCH_MAX_ITEMS) {
      return next({
        status: 400,
        message: `items array must contain at most ${STATUS_BATCH_MAX_ITEMS} entries`,
      });
    }

    const items: MediaItemRef[] = [];
    for (const entry of rawItems) {
      const mediaType = parseMediaType(String(entry?.mediaType ?? ''));
      const tmdbId = parseTmdbId(String(entry?.tmdbId ?? ''));
      if (!mediaType || tmdbId == null) {
        return next({
          status: 400,
          message: 'each item requires mediaType (movie|tv) and tmdbId',
        });
      }
      items.push({ mediaType, tmdbId });
    }

    const results = await getMediaActionDispatcher().getStatuses(
      req.user.id,
      dedupeMediaItems(items)
    );
    return res.status(200).json({
      results: results.map((r) => toResponse(r)),
    });
  } catch (e) {
    return handleActionError(
      e,
      next,
      'Unable to retrieve media action statuses.'
    );
  }
});

mediaActionsRoutes.post(
  '/:mediaType/:tmdbId/watched',
  async (req, res, next) => {
    try {
      if (!req.user?.id) {
        return next({ status: 401, message: 'Unauthorized' });
      }
      const item = parseItem(req.params.mediaType, req.params.tmdbId);
      if ('error' in item) {
        return next({ status: 400, message: item.error });
      }

      const watchedAt = req.body?.watchedAt === 'release' ? 'release' : 'now';
      const ratingStars =
        req.body?.ratingStars != null && req.body.ratingStars !== ''
          ? Number(req.body.ratingStars)
          : undefined;
      if (ratingStars != null && Number.isNaN(ratingStars)) {
        return next({ status: 400, message: 'ratingStars must be a number' });
      }

      const result = await getMediaActionDispatcher().markWatched(
        req.user.id,
        item,
        { watchedAt, ratingStars }
      );
      return respondWrite(res, result);
    } catch (e) {
      return handleActionError(e, next, 'Unable to mark media as watched.');
    }
  }
);

mediaActionsRoutes.post(
  '/:mediaType/:tmdbId/unwatched',
  async (req, res, next) => {
    try {
      if (!req.user?.id) {
        return next({ status: 401, message: 'Unauthorized' });
      }
      const item = parseItem(req.params.mediaType, req.params.tmdbId);
      if ('error' in item) {
        return next({ status: 400, message: item.error });
      }

      const result = await getMediaActionDispatcher().unmarkWatched(
        req.user.id,
        item,
        { removeRating: Boolean(req.body?.removeRating) }
      );
      return respondWrite(res, result);
    } catch (e) {
      return handleActionError(e, next, 'Unable to mark media as unwatched.');
    }
  }
);

mediaActionsRoutes.post('/:mediaType/:tmdbId/rate', async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return next({ status: 401, message: 'Unauthorized' });
    }
    const item = parseItem(req.params.mediaType, req.params.tmdbId);
    if ('error' in item) {
      return next({ status: 400, message: item.error });
    }

    if (req.body?.ratingStars == null || req.body.ratingStars === '') {
      return next({ status: 400, message: 'ratingStars is required' });
    }
    const ratingStars = Number(req.body.ratingStars);
    if (Number.isNaN(ratingStars)) {
      return next({ status: 400, message: 'ratingStars must be a number' });
    }

    const result = await getMediaActionDispatcher().rate(req.user.id, item, {
      ratingStars,
    });
    return respondWrite(res, result);
  } catch (e) {
    return handleActionError(e, next, 'Unable to rate media.');
  }
});

export default mediaActionsRoutes;
