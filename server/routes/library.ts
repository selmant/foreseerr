import type {
  LibraryBrowseResponse,
  LibraryFacetsResponse,
  LibraryItemInspectorResponse,
  LibrarySeasonEpisodesResponse,
  LibrarySeriesDetailResponse,
  LibraryWatchNowResponse,
} from '@server/interfaces/api/libraryInterfaces';
import {
  buildWatchNowResponse,
  getLibraryFacetsForUser,
  getLibraryItemImage,
  getLibraryItemInspector,
  getLibrarySeasonEpisodes,
  getLibrarySeriesDetail,
  listAvailableLibrary,
  listBrowseLibrary,
} from '@server/lib/library';
import { isJellyfinItemId } from '@server/lib/libraryBrowse';
import { parseLibraryBrowseQuery } from '@server/lib/libraryBrowseQuery';
import { Router, type RequestHandler } from 'express';

const libraryRoutes = Router();

function parseAvailableQuery(query: Record<string, unknown>) {
  const mediaType =
    query.mediaType === 'movie' || query.mediaType === 'tv'
      ? query.mediaType
      : undefined;
  return {
    take: Math.min(Math.max(Number(query.take) || 20, 1), 50),
    skip: Math.max(Number(query.skip) || 0, 0),
    mediaType: mediaType as 'movie' | 'tv' | undefined,
  };
}

function availablePage(
  results: unknown[],
  total: number,
  take: number,
  skip: number
) {
  return {
    pageInfo: {
      pages: Math.ceil(total / take) || 1,
      pageSize: take,
      results: total,
      page: Math.floor(skip / take) + 1,
    },
    results,
  };
}

function listAvailableRoute(options: {
  requireQuery: boolean;
  failureMessage: string;
}): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return next({ status: 401, message: 'Unauthorized' });
      }
      const { take, skip, mediaType } = parseAvailableQuery(req.query);
      const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      if (options.requireQuery && !query) {
        return res.status(200).json(availablePage([], 0, take, skip));
      }
      const response = await listAvailableLibrary({
        take,
        skip,
        mediaType,
        query: query || undefined,
        userId: req.user.id,
      });
      return res.status(200).json({
        ...availablePage(response.results, response.total, take, skip),
        ...(response.code ? { code: response.code } : {}),
      });
    } catch (error) {
      return next({
        status: 500,
        message:
          error instanceof Error ? error.message : options.failureMessage,
      });
    }
  };
}

libraryRoutes.get<unknown, LibraryWatchNowResponse>(
  '/watch-now',
  async (req, res, next) => {
    try {
      if (!req.user) {
        return next({ status: 401, message: 'Unauthorized' });
      }
      const payload = await buildWatchNowResponse(req.user.id);
      return res.status(200).json(payload);
    } catch (e) {
      return next({
        status: 500,
        message:
          e instanceof Error ? e.message : 'Failed to load library shelves',
      });
    }
  }
);

libraryRoutes.get(
  '/available',
  listAvailableRoute({
    requireQuery: false,
    failureMessage: 'Failed to load available library',
  })
);

libraryRoutes.get(
  '/search',
  listAvailableRoute({
    requireQuery: true,
    failureMessage: 'Failed to search library',
  })
);

libraryRoutes.get<unknown, LibraryBrowseResponse>(
  '/browse',
  async (req, res, next) => {
    try {
      if (!req.user) {
        return next({ status: 401, message: 'Unauthorized' });
      }
      const query = parseLibraryBrowseQuery(
        req.query as Record<string, unknown>
      );
      const { results, total, code } = await listBrowseLibrary(
        req.user.id,
        query
      );

      return res.status(200).json({
        pageInfo: {
          pages: Math.ceil(total / query.take) || 1,
          pageSize: query.take,
          results: total,
          page: Math.floor(query.skip / query.take) + 1,
        },
        results,
        ...(code ? { code } : {}),
      });
    } catch (e) {
      return next({
        status: 500,
        message: e instanceof Error ? e.message : 'Failed to browse library',
      });
    }
  }
);

libraryRoutes.get<unknown, LibraryFacetsResponse>(
  '/facets',
  async (req, res, next) => {
    try {
      if (!req.user) {
        return next({ status: 401, message: 'Unauthorized' });
      }
      const mediaType =
        req.query.mediaType === 'movie' || req.query.mediaType === 'tv'
          ? req.query.mediaType
          : undefined;
      const payload = await getLibraryFacetsForUser(req.user.id, mediaType);
      return res.status(200).json(payload);
    } catch (e) {
      return next({
        status: 500,
        message:
          e instanceof Error ? e.message : 'Failed to load library facets',
      });
    }
  }
);

libraryRoutes.get<
  { jellyfinItemId: string; imageType: string },
  Buffer | { message: string }
>('/items/:jellyfinItemId/images/:imageType', async (req, res, next) => {
  try {
    if (!req.user) {
      return next({ status: 401, message: 'Unauthorized' });
    }
    if (!isJellyfinItemId(req.params.jellyfinItemId)) {
      return next({ status: 404, message: 'Not found' });
    }
    const imageType =
      req.params.imageType === 'primary' || req.params.imageType === 'backdrop'
        ? req.params.imageType
        : undefined;
    if (!imageType) {
      return next({ status: 404, message: 'Not found' });
    }
    const image = await getLibraryItemImage(
      req.user.id,
      req.params.jellyfinItemId,
      imageType
    );
    if (!image.ok) {
      return next({
        status: image.status,
        message: image.code ?? 'Failed to load image',
      });
    }
    res.setHeader('Content-Type', image.contentType);
    res.setHeader('Cache-Control', 'private, max-age=21600');
    return res.status(200).end(image.buffer);
  } catch (e) {
    return next({
      status: 502,
      message: e instanceof Error ? e.message : 'Failed to load library image',
    });
  }
});

libraryRoutes.get<{ jellyfinItemId: string }, LibraryItemInspectorResponse>(
  '/items/:jellyfinItemId',
  async (req, res, next) => {
    try {
      if (!req.user) {
        return next({ status: 401, message: 'Unauthorized' });
      }
      if (!isJellyfinItemId(req.params.jellyfinItemId)) {
        return next({ status: 404, message: 'Not found' });
      }
      const payload = await getLibraryItemInspector(
        req.user.id,
        req.params.jellyfinItemId
      );
      return res.status(200).json(payload);
    } catch (e) {
      return next({
        status: 500,
        message: e instanceof Error ? e.message : 'Failed to load library item',
      });
    }
  }
);

libraryRoutes.get<{ jellyfinSeriesId: string }, LibrarySeriesDetailResponse>(
  '/series/:jellyfinSeriesId',
  async (req, res, next) => {
    try {
      if (!req.user) {
        return next({ status: 401, message: 'Unauthorized' });
      }
      if (!isJellyfinItemId(req.params.jellyfinSeriesId)) {
        return next({ status: 404, message: 'Not found' });
      }
      const payload = await getLibrarySeriesDetail(
        req.user.id,
        req.params.jellyfinSeriesId
      );
      return res.status(200).json(payload);
    } catch (e) {
      return next({
        status: 500,
        message:
          e instanceof Error ? e.message : 'Failed to load library series',
      });
    }
  }
);

libraryRoutes.get<
  { jellyfinSeriesId: string; seasonId: string },
  LibrarySeasonEpisodesResponse
>(
  '/series/:jellyfinSeriesId/seasons/:seasonId/episodes',
  async (req, res, next) => {
    try {
      if (!req.user) {
        return next({ status: 401, message: 'Unauthorized' });
      }
      if (
        !isJellyfinItemId(req.params.jellyfinSeriesId) ||
        !isJellyfinItemId(req.params.seasonId)
      ) {
        return next({ status: 404, message: 'Not found' });
      }
      const payload = await getLibrarySeasonEpisodes(
        req.user.id,
        req.params.jellyfinSeriesId,
        req.params.seasonId
      );
      return res.status(200).json(payload);
    } catch (e) {
      return next({
        status: 500,
        message:
          e instanceof Error ? e.message : 'Failed to load library episodes',
      });
    }
  }
);

export default libraryRoutes;
