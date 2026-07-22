import TheMovieDb from '@server/api/themoviedb';
import Media from '@server/entity/Media';
import { enrichResultsWithRatings } from '@server/lib/ratings';
import logger from '@server/logger';
import {
  mapCastCredits,
  mapCrewCredits,
  mapPersonDetails,
} from '@server/models/Person';
import { Router } from 'express';

const personRoutes = Router();

personRoutes.get('/:id', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const person = await tmdb.getPerson({
      personId: Number(req.params.id),
      language: (req.query.language as string) ?? req.locale,
    });
    return res.status(200).json(mapPersonDetails(person));
  } catch (e) {
    logger.debug('Something went wrong retrieving person', {
      label: 'API',
      errorMessage: e.message,
      personId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve person.',
    });
  }
});

personRoutes.get('/:id/combined_credits', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const combinedCredits = await tmdb.getPersonCombinedCredits({
      personId: Number(req.params.id),
      language: (req.query.language as string) ?? req.locale,
    });

    const castMedia = await Media.getRelatedMedia(
      req.user,
      combinedCredits.cast
        .filter((result) => result.media_type)
        .map((result) => ({
          tmdbId: result.id,
          mediaType: result.media_type!,
        }))
    );

    const crewMedia = await Media.getRelatedMedia(
      req.user,
      combinedCredits.crew
        .filter((result) => result.media_type)
        .map((result) => ({
          tmdbId: result.id,
          mediaType: result.media_type!,
        }))
    );

    const cast = combinedCredits.cast
      .map((result) =>
        mapCastCredits(
          result,
          castMedia.find(
            (med) =>
              med.tmdbId === result.id && med.mediaType === result.media_type
          )
        )
      )
      .filter((item) => !item.adult && item.character !== 'Thanks');
    const crew = combinedCredits.crew
      .map((result) =>
        mapCrewCredits(
          result,
          crewMedia.find(
            (med) =>
              med.tmdbId === result.id && med.mediaType === result.media_type
          )
        )
      )
      .filter((item) => !item.adult && item.job !== 'Thanks');
    const enriched = await enrichResultsWithRatings([...cast, ...crew]);

    return res.status(200).json({
      cast: enriched.slice(0, cast.length),
      crew: enriched.slice(cast.length),
      id: combinedCredits.id,
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving combined credits', {
      label: 'API',
      errorMessage: e.message,
      personId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve combined credits.',
    });
  }
});

export default personRoutes;
