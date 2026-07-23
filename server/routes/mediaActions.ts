import {
  classifyWriteOutcome,
  getMediaActionDispatcher,
  writeHttpStatus,
  type MediaActionAggregate,
  type MediaActionMediaType,
  type MediaItemRef,
} from '@server/lib/mediaActions';
import logger from '@server/logger';
import { Router } from 'express';

export const STATUS_BATCH_MAX_ITEMS = 100;

const mediaActionsRoutes = Router();

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
