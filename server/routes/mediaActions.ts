import {
  classifyWriteOutcome,
  getMediaActionDispatcher,
  writeHttpStatus,
  type MediaActionAggregate,
  type MediaActionMediaType,
  type MediaItemRef,
} from '@server/lib/mediaActions';
import { jellyfinEpisodeActions } from '@server/lib/mediaActions/jellyfin';
import { traktEpisodeActions } from '@server/lib/mediaActions/traktEpisodes';
import logger from '@server/logger';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

export const STATUS_BATCH_MAX_ITEMS = 100;

const mediaActionsRoutes = Router();

const positiveIdSchema = z.coerce.number().int().positive().max(2_147_483_647);
const episodeCoordinateSchema = z.coerce.number().int().min(0).max(10_000);

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
      const [traktStatus, jellyfinStatus] = await Promise.all([
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
      ]);

      const allWatched = new Set<number>();
      for (const ep of traktStatus.watchedEpisodeNumbers) {
        allWatched.add(ep);
      }
      for (const ep of jellyfinStatus.watchedEpisodeNumbers) {
        allWatched.add(ep);
      }

      return res.status(200).json({
        available: traktStatus.available || jellyfinStatus.available,
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

      const [traktOk, jellyfinOk] = await Promise.all([
        traktEpisodeActions.setWatched(
          req.user.id,
          parsed.tmdbId,
          parsed.seasonNumber,
          parsed.episodeNumber,
          watched
        ),
        jellyfinEpisodeActions.setEpisodeWatched(
          req.user.id,
          parsed.tmdbId,
          parsed.seasonNumber,
          parsed.episodeNumber,
          watched
        ),
      ]);

      return res.status(traktOk ? 200 : 502).json({
        providers: [
          {
            provider: 'trakt',
            ok: traktOk,
            watched: traktOk ? watched : !watched,
          },
          {
            provider: 'jellyfin',
            ok: jellyfinOk,
            watched: jellyfinOk ? watched : !watched,
          },
        ],
      });
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
