import {
  fetchBatchCombinedRatings,
  type RatingsBatchItem,
} from '@server/lib/ratings';
import logger from '@server/logger';
import { Router } from 'express';

const ratingsRoutes = Router();

function parseMediaType(value: unknown): 'movie' | 'tv' | null {
  if (value === 'movie' || value === 'tv') {
    return value;
  }
  return null;
}

function parseTmdbId(value: unknown): number | null {
  const id = Number(value);
  if (!Number.isFinite(id) || id <= 0) {
    return null;
  }
  return Math.trunc(id);
}

ratingsRoutes.post('/batch', async (req, res, next) => {
  try {
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!rawItems) {
      return next({ status: 400, message: 'items array is required' });
    }

    if (rawItems.length > 100) {
      return next({ status: 400, message: 'items array max length is 100' });
    }

    const items: RatingsBatchItem[] = [];
    for (const entry of rawItems) {
      const mediaType = parseMediaType(entry?.mediaType);
      const tmdbId = parseTmdbId(entry?.tmdbId);
      if (!mediaType || tmdbId == null) {
        return next({
          status: 400,
          message: 'each item requires mediaType (movie|tv) and tmdbId',
        });
      }
      const year =
        entry?.year != null && Number.isFinite(Number(entry.year))
          ? Number(entry.year)
          : undefined;
      items.push({
        mediaType,
        tmdbId,
        title: typeof entry?.title === 'string' ? entry.title : undefined,
        year,
      });
    }

    const results = await fetchBatchCombinedRatings(items);
    return res.status(200).json({ results });
  } catch (e) {
    logger.error('Unable to retrieve batch ratings', {
      label: 'API',
      errorMessage: e instanceof Error ? e.message : 'unknown error',
    });
    return next({
      status: 500,
      message: 'Unable to retrieve batch ratings.',
    });
  }
});

export default ratingsRoutes;
