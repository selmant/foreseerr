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
  resolveDiscoverItems,
  type ResolvableDiscoverItem,
} from '@server/lib/discover/resolveItems';
import {
  hasDiscoverTmdbId,
  imdbSourceUrl,
  omitUnmappedDiscoverItems,
  recordUnmappedItems,
  shouldHideUnmappedFromQuery,
  tmdbSourceUrl,
} from '@server/lib/discover/unmapped';
import type { IdRef } from '@server/lib/mapping/types';
import { Router } from 'express';

const mdblistDiscoverRoutes = Router();

const mapItems = (items: MdblistDiscoverItem[]): ResolvableDiscoverItem[] =>
  items.map((item) => {
    const sourceId = hasDiscoverTmdbId(item.tmdbId)
      ? String(item.tmdbId)
      : item.imdbId || (item.tvdbId ? String(item.tvdbId) : item.title);
    // The media type is only known when MDBList said so; a unified list leaves
    // it open until the mapping layer settles it.
    const mediaType = item.mediaType;
    const sourceUrl = item.imdbId
      ? imdbSourceUrl(item.imdbId)
      : hasDiscoverTmdbId(item.tmdbId) && mediaType
        ? tmdbSourceUrl(mediaType, item.tmdbId)
        : undefined;
    // IMDB is the id MDBList carries for practically every list item and the one
    // TMDB `/find` resolves reliably; TVDB is the fallback for shows.
    const from: IdRef | undefined = item.imdbId
      ? { ns: 'imdb', id: item.imdbId }
      : item.tvdbId
        ? { ns: 'tvdb_show', id: String(item.tvdbId) }
        : undefined;
    return {
      id: item.tmdbId ?? 0,
      ratingKey: `mdblist-${mediaType ?? 'unknown'}-${sourceId}`,
      ...(hasDiscoverTmdbId(item.tmdbId) ? { tmdbId: item.tmdbId } : {}),
      ...(mediaType ? { mediaType } : {}),
      title: item.title,
      source: 'mdblist' as const,
      sourceId,
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(from ? { from } : {}),
    };
  });

const resolvedMdblistItems = async (
  items: MdblistDiscoverItem[]
): Promise<WatchlistItem[]> => {
  const resolved = await resolveDiscoverItems(mapItems(items), {
    discoverSource: 'mdblist/list',
  });
  recordUnmappedItems(resolved, {
    discoverSource: 'mdblist/list',
  });
  return resolved;
};

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
        await resolvedMdblistItems(items),
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
