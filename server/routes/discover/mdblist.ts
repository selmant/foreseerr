import MdblistAPI, {
  MdblistNotConfiguredError,
  type MdblistDiscoverItem,
} from '@server/api/mdblist';
import type {
  WatchlistItem,
  WatchlistResponse,
} from '@server/interfaces/api/discoverInterfaces';
import { handleMdblistDiscoverRouteError } from '@server/lib/discover/providerErrors';
import {
  hasDiscoverTmdbId,
  imdbSourceUrl,
  omitUnmappedDiscoverItems,
  shouldHideUnmappedFromQuery,
  tmdbSourceUrl,
} from '@server/lib/discover/unmapped';
import { Router } from 'express';

const mdblistDiscoverRoutes = Router();

const mapItems = (items: MdblistDiscoverItem[]): WatchlistItem[] =>
  items.map((item) => {
    const sourceId = hasDiscoverTmdbId(item.tmdbId)
      ? String(item.tmdbId)
      : item.imdbId || item.title;
    const sourceUrl = item.imdbId
      ? imdbSourceUrl(item.imdbId)
      : hasDiscoverTmdbId(item.tmdbId)
        ? tmdbSourceUrl(item.mediaType, item.tmdbId)
        : undefined;
    return {
      id: item.tmdbId ?? 0,
      ratingKey: `mdblist-${item.mediaType}-${sourceId}`,
      ...(hasDiscoverTmdbId(item.tmdbId) ? { tmdbId: item.tmdbId } : {}),
      mediaType: item.mediaType,
      title: item.title,
      source: 'mdblist' as const,
      sourceId,
      ...(sourceUrl ? { sourceUrl } : {}),
    };
  });

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
      results: omitUnmappedDiscoverItems(
        mapItems(items),
        shouldHideUnmappedFromQuery(req.query)
      ),
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
