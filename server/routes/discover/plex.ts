import PlexTvAPI from '@server/api/plextv';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { Watchlist } from '@server/entity/Watchlist';
import type { WatchlistResponse } from '@server/interfaces/api/discoverInterfaces';
import { enrichResultsWithRatings } from '@server/lib/ratings';
import { Router } from 'express';

const plexDiscoverRoutes = Router();

plexDiscoverRoutes.get<unknown, WatchlistResponse>('/', async (req, res) => {
  const userRepository = getRepository(User);
  const itemsPerPage = 20;
  const page = req.query.page ? Number(req.query.page) : 1;
  const offset = (page - 1) * itemsPerPage;
  const activeUser = await userRepository.findOne({
    where: { id: req.user?.id },
    select: ['id', 'plexToken'],
  });
  if (activeUser && !activeUser.plexToken) {
    const [results, total] = await getRepository(Watchlist).findAndCount({
      where: { requestedBy: { id: activeUser.id } },
      relations: {},
      take: itemsPerPage,
      skip: offset,
    });
    if (total) {
      return res.json({
        page,
        totalPages: Math.ceil(total / itemsPerPage),
        totalResults: total,
        results,
      });
    }
  }
  if (!activeUser?.plexToken) {
    return res.json({
      page: 1,
      totalPages: 1,
      totalResults: 0,
      results: [],
    });
  }
  const watchlist = await new PlexTvAPI(activeUser.plexToken).getWatchlist({
    offset,
  });
  const results = await enrichResultsWithRatings(
    watchlist.items.map((item) => ({
      id: item.tmdbId,
      ratingKey: item.ratingKey,
      title: item.title,
      mediaType: item.type === 'show' ? ('tv' as const) : ('movie' as const),
      tmdbId: item.tmdbId,
    }))
  );
  return res.json({
    page,
    totalPages: Math.ceil(watchlist.totalSize / itemsPerPage),
    totalResults: watchlist.totalSize,
    results,
  });
});

export default plexDiscoverRoutes;
