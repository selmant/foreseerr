import SimklAPI from '@server/api/simkl';
import { getRepository } from '@server/datasource';
import {
  SimklSyncItem,
  type SimklItemStatus,
} from '@server/entity/SimklSyncItem';
import type {
  WatchlistItem,
  WatchlistResponse,
} from '@server/interfaces/api/discoverInterfaces';
import { syncSimklUser } from '@server/lib/simklSync';
import { Router } from 'express';

const simklDiscoverRoutes = Router();
const STATUSES = new Set<SimklItemStatus>([
  'watching',
  'plantowatch',
  'hold',
  'completed',
  'dropped',
]);
const sourceUrl = (item: SimklSyncItem) =>
  `https://simkl.com/${item.simklType === 'movie' ? 'movies' : item.simklType === 'anime' ? 'anime' : 'tv'}/${encodeURIComponent(item.slug || item.simklId)}`;

const catalogItems = (
  payload: Record<string, unknown>
): Record<string, unknown>[] =>
  Object.values(payload).flatMap((value) =>
    Array.isArray(value)
      ? value.filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === 'object'
        )
      : []
  );

function toWatchlistItem(item: SimklSyncItem): WatchlistItem {
  const mediaType = item.simklType === 'movie' ? 'movie' : 'tv';
  return {
    id: (item.tmdbId ?? Number(item.simklId)) || 0,
    ratingKey: `simkl-${item.simklType}-${item.simklId}`,
    ...(item.tmdbId ? { tmdbId: item.tmdbId } : {}),
    mediaType,
    title: item.title,
    source: 'simkl',
    sourceId: item.simklId,
    sourceUrl: sourceUrl(item),
    ...(item.posterPath ? { image: item.posterPath } : {}),
  };
}

function catalogWatchlistItems(
  payloads: Record<string, unknown>[],
  typeHint: string,
  keyPrefix: string
): WatchlistItem[] {
  const results: WatchlistItem[] = [];
  for (const item of payloads.flatMap(catalogItems)) {
    const ids = (
      item.ids && typeof item.ids === 'object' ? item.ids : {}
    ) as Record<string, unknown>;
    const id = String(ids.simkl ?? item.id ?? '');
    const tmdbId = Number(ids.tmdb);
    const mediaType =
      String(item.type) === 'movie' || typeHint === 'movie' ? 'movie' : 'tv';
    if (!id || typeof item.title !== 'string') continue;
    results.push({
      id: Number.isFinite(tmdbId) && tmdbId > 0 ? tmdbId : Number(id) || 0,
      ratingKey: `${keyPrefix}-${id}`,
      ...(Number.isFinite(tmdbId) && tmdbId > 0 ? { tmdbId } : {}),
      mediaType,
      title: item.title,
      source: 'simkl',
      sourceId: id,
      sourceUrl: `https://simkl.com/${mediaType === 'movie' ? 'movies' : 'tv'}/${encodeURIComponent(String(item.slug ?? id))}`,
      ...(typeof item.poster === 'string' ? { image: item.poster } : {}),
    });
  }
  return results;
}

simklDiscoverRoutes.get('/library', async (req, res, next) => {
  if (!req.user?.id) return next({ status: 401, message: 'Unauthorized' });
  const result = await syncSimklUser(
    req.user.id,
    String(req.query.refresh) === 'true'
  );
  const status =
    typeof req.query.status === 'string' &&
    STATUSES.has(req.query.status as SimklItemStatus)
      ? (req.query.status as SimklItemStatus)
      : undefined;
  const mediaType = String(req.query.mediaType ?? 'all');
  const types =
    mediaType === 'movie'
      ? ['movie']
      : mediaType === 'anime'
        ? ['anime']
        : mediaType === 'tv'
          ? ['show']
          : ['movie', 'show', 'anime'];
  const rows = await getRepository(SimklSyncItem)
    .createQueryBuilder('item')
    .where('item.userId = :userId', { userId: req.user.id })
    .andWhere('item.simklType IN (:...types)', { types })
    .andWhere(status ? 'item.status = :status' : '1=1', { status })
    .orderBy('item.addedAt', 'DESC', 'NULLS LAST')
    .getMany();
  const page = Math.max(1, Number(req.query.page) || 1);
  const start = (page - 1) * 20;
  return res.status(200).json({
    page,
    totalResults: rows.length,
    totalPages: Math.max(1, Math.ceil(rows.length / 20)),
    hasMore: start + 20 < rows.length,
    results: rows.slice(start, start + 20).map(toWatchlistItem),
    providerState: {
      source: 'simkl',
      stale: result.stale,
      lastSuccessfulSyncAt: result.lastSuccessfulSyncAt,
    },
  } satisfies WatchlistResponse);
});

simklDiscoverRoutes.get('/trending', async (req, res, next) => {
  try {
    const type = String(req.query.mediaType ?? 'all');
    const page = Math.max(1, Number(req.query.page) || 1);
    const period = ['day', 'week', 'month'].includes(String(req.query.period))
      ? String(req.query.period)
      : 'week';
    const paths =
      type === 'movie'
        ? ['/movies/trending']
        : type === 'anime'
          ? ['/anime/trending']
          : type === 'tv'
            ? ['/tv/trending']
            : ['/movies/trending', '/tv/trending'];
    const payloads = await Promise.all(
      paths.map((path) => new SimklAPI().getCatalog(path, { page, period }))
    );
    const results = catalogWatchlistItems(payloads, type, 'simkl-public');
    return res.status(200).json({
      page,
      hasMore: results.length >= 20,
      results: results.slice(0, 20),
    } satisfies WatchlistResponse);
  } catch (error) {
    return next({
      status: 503,
      message:
        error instanceof Error
          ? error.message
          : 'Unable to retrieve Simkl trending titles.',
    });
  }
});

simklDiscoverRoutes.get('/best', async (req, res, next) => {
  try {
    const mediaType = String(req.query.mediaType) === 'anime' ? 'anime' : 'tv';
    const filter = ['all', 'year', 'month', 'voted', 'watched'].includes(
      String(req.query.filter)
    )
      ? String(req.query.filter)
      : 'all';
    const page = Math.max(1, Number(req.query.page) || 1);
    const payload = await new SimklAPI().getCatalog(`/${mediaType}/best`, {
      page,
      filter,
    });
    const results = catalogWatchlistItems([payload], mediaType, 'simkl-best');
    return res.status(200).json({
      page,
      hasMore: results.length >= 20,
      results: results.slice(0, 20),
    } satisfies WatchlistResponse);
  } catch (error) {
    return next({
      status: 503,
      message:
        error instanceof Error
          ? error.message
          : 'Unable to retrieve Simkl best titles.',
    });
  }
});

simklDiscoverRoutes.get('/premieres', async (req, res, next) => {
  try {
    const mediaType = String(req.query.mediaType) === 'anime' ? 'anime' : 'tv';
    const window = String(req.query.window) === 'upcoming' ? 'upcoming' : 'new';
    const page = Math.max(1, Number(req.query.page) || 1);
    const payload = await new SimklAPI().getCatalog(
      `/${mediaType}/premieres/${window}`,
      { page }
    );
    const results = catalogWatchlistItems(
      [payload],
      mediaType,
      'simkl-premieres'
    );
    return res.status(200).json({
      page,
      hasMore: results.length >= 20,
      results: results.slice(0, 20),
    } satisfies WatchlistResponse);
  } catch (error) {
    return next({
      status: 503,
      message:
        error instanceof Error
          ? error.message
          : 'Unable to retrieve Simkl premieres.',
    });
  }
});

export default simklDiscoverRoutes;
