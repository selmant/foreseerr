import TheMovieDb from '@server/api/themoviedb';
import { MediaType } from '@server/constants/media';
import Media from '@server/entity/Media';
import { enrichResultsWithRatings } from '@server/lib/ratings';
import logger from '@server/logger';
import { mapCollection } from '@server/models/Collection';
import { Router } from 'express';

const collectionRoutes = Router();

collectionRoutes.get<{ id: string }>('/:id', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const collection = await tmdb.getCollection({
      collectionId: Number(req.params.id),
      language: (req.query.language as string) ?? req.locale,
    });

    const media = await Media.getRelatedMedia(
      req.user,
      collection.parts.map((part) => ({
        tmdbId: part.id,
        mediaType: MediaType.MOVIE,
      }))
    );

    const mapped = mapCollection(collection, media);
    mapped.parts = await enrichResultsWithRatings(mapped.parts);
    return res.status(200).json(mapped);
  } catch (e) {
    logger.debug('Something went wrong retrieving collection', {
      label: 'API',
      errorMessage: e.message,
      collectionId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve collection.',
    });
  }
});

export default collectionRoutes;
