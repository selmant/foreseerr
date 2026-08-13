import type {
  LibraryAvailableResponse,
  LibraryBrowseResponse,
  LibraryFacetsResponse,
  LibrarySeasonEpisodesResponse,
  LibrarySeriesDetailResponse,
  LibraryWatchNowResponse,
} from '@server/interfaces/api/libraryInterfaces';
import {
  buildWatchNowResponse,
  getLibraryFacetsForUser,
  getLibrarySeasonEpisodes,
  getLibrarySeriesDetail,
  listAvailableLibrary,
  listBrowseLibrary,
} from '@server/lib/library';
import { parseLibraryBrowseQuery } from '@server/lib/libraryBrowseQuery';
import { Router } from 'express';

const libraryRoutes = Router();

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

libraryRoutes.get<unknown, LibraryAvailableResponse>(
  '/available',
  async (req, res, next) => {
    try {
      if (!req.user) {
        return next({ status: 401, message: 'Unauthorized' });
      }
      const take = Math.min(Math.max(Number(req.query.take) || 20, 1), 50);
      const skip = Math.max(Number(req.query.skip) || 0, 0);
      const mediaType =
        req.query.mediaType === 'movie' || req.query.mediaType === 'tv'
          ? req.query.mediaType
          : undefined;
      const query = typeof req.query.q === 'string' ? req.query.q : undefined;

      const { results, total, code } = await listAvailableLibrary({
        take,
        skip,
        mediaType,
        query,
        userId: req.user.id,
      });

      return res.status(200).json({
        pageInfo: {
          pages: Math.ceil(total / take) || 1,
          pageSize: take,
          results: total,
          page: Math.floor(skip / take) + 1,
        },
        results,
        ...(code ? { code } : {}),
      });
    } catch (e) {
      return next({
        status: 500,
        message:
          e instanceof Error ? e.message : 'Failed to load available library',
      });
    }
  }
);

libraryRoutes.get<unknown, LibraryAvailableResponse>(
  '/search',
  async (req, res, next) => {
    try {
      if (!req.user) {
        return next({ status: 401, message: 'Unauthorized' });
      }
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      if (!q) {
        return res.status(200).json({
          pageInfo: { pages: 1, pageSize: 20, results: 0, page: 1 },
          results: [],
        });
      }
      const take = Math.min(Math.max(Number(req.query.take) || 20, 1), 50);
      const skip = Math.max(Number(req.query.skip) || 0, 0);
      const mediaType =
        req.query.mediaType === 'movie' || req.query.mediaType === 'tv'
          ? req.query.mediaType
          : undefined;

      const { results, total, code } = await listAvailableLibrary({
        take,
        skip,
        mediaType,
        query: q,
        userId: req.user.id,
      });

      return res.status(200).json({
        pageInfo: {
          pages: Math.ceil(total / take) || 1,
          pageSize: take,
          results: total,
          page: Math.floor(skip / take) + 1,
        },
        results,
        ...(code ? { code } : {}),
      });
    } catch (e) {
      return next({
        status: 500,
        message: e instanceof Error ? e.message : 'Failed to search library',
      });
    }
  }
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
      const payload = await getLibraryFacetsForUser(req.user.id);
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

libraryRoutes.get<{ jellyfinSeriesId: string }, LibrarySeriesDetailResponse>(
  '/series/:jellyfinSeriesId',
  async (req, res, next) => {
    try {
      if (!req.user) {
        return next({ status: 401, message: 'Unauthorized' });
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
