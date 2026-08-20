import MdblistAPI, {
  MdblistNotConfiguredError,
  type MdblistDiscoverItem,
} from '@server/api/mdblist';
import type {
  WatchlistItem,
  WatchlistResponse,
} from '@server/interfaces/api/discoverInterfaces';
import { handleMdblistDiscoverRouteError } from '@server/lib/discover/providerErrors';
import { Router } from 'express';

const mdblistDiscoverRoutes = Router();

const mapItems = (items: MdblistDiscoverItem[]): WatchlistItem[] =>
  items.map((item) => ({
    id: item.tmdbId,
    ratingKey: `mdblist-${item.mediaType}-${item.tmdbId}`,
    tmdbId: item.tmdbId,
    mediaType: item.mediaType,
    title: item.title,
  }));

mdblistDiscoverRoutes.get('/lists/search', async (req, res, next) => {
  try {
    const mdblist = MdblistAPI.getInstance();
    if (!mdblist.isConfigured()) throw new MdblistNotConfiguredError();
    const query = String(req.query.query ?? '').trim();
    return res.status(200).json({
      results: query ? await mdblist.searchLists(query) : [],
    });
  } catch (error) {
    return handleMdblistDiscoverRouteError(
      error,
      next,
      'Unable to search MDBList lists.'
    );
  }
});

mdblistDiscoverRoutes.get('/list', async (req, res, next) => {
  try {
    const mdblist = MdblistAPI.getInstance();
    if (!mdblist.isConfigured()) throw new MdblistNotConfiguredError();
    const url = String(req.query.url ?? '').trim();
    if (!url)
      return next({ status: 400, message: 'url query parameter is required' });
    const page = req.query.page ? Number(req.query.page) : 1;
    const { title, items, hasMore } = await mdblist.getListItems(url, {
      limit: 20,
      offset: Math.max(0, (page - 1) * 20),
    });
    return res.status(200).json({
      page,
      hasMore,
      results: mapItems(items),
      title,
    } satisfies WatchlistResponse & { title: string });
  } catch (error) {
    return handleMdblistDiscoverRouteError(
      error,
      next,
      'Unable to retrieve MDBList list.'
    );
  }
});

export default mdblistDiscoverRoutes;
