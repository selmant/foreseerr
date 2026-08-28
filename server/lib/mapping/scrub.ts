import { getRepository } from '@server/datasource';
import { MappingLink } from '@server/entity/MappingLink';
import mappingService from '@server/lib/mapping/service';
import logger from '@server/logger';

/**
 * Drop `tmdb_movie` links Simkl wrote for anime using the same integer as a
 * real `tmdb_show`.
 *
 * Simkl's anime detail payload exposes one `ids.tmdb` with no movie/show
 * discriminator. Persisting that integer under `tmdb_movie` is what made
 * AniList trending render Slime Season 4 as Chasing Mavericks (movie/82684).
 */
export async function scrubSimklAnimeMovieCollisions(): Promise<number> {
  const repository = getRepository(MappingLink);
  const collisions: { externalId: string }[] = await repository
    .createQueryBuilder('movie')
    .select('DISTINCT movie.externalId', 'externalId')
    .innerJoin(
      MappingLink,
      'show',
      `show.namespace = 'tmdb_show' AND show.externalId = movie.externalId`
    )
    .where('movie.namespace = :movieNs', { movieNs: 'tmdb_movie' })
    .andWhere('movie.sourceKey = :source', { source: 'simkl-live:tmdb' })
    .getRawMany();

  if (!collisions.length) return 0;

  const ids = collisions.map((row) => row.externalId);
  const result = await repository
    .createQueryBuilder()
    .delete()
    .where('namespace = :movieNs', { movieNs: 'tmdb_movie' })
    .andWhere('sourceKey = :source', { source: 'simkl-live:tmdb' })
    .andWhere('externalId IN (:...ids)', { ids })
    .execute();

  const removed = result.affected ?? 0;
  if (removed > 0) {
    mappingService.invalidate();
    logger.warn('Removed Simkl anime TMDB movie collision links', {
      label: 'Mapping',
      removed,
      ids: ids.length,
    });
  }
  return removed;
}
