import SimklAPI from '@server/api/simkl';
import type TheMovieDb from '@server/api/themoviedb';
import { getRepository } from '@server/datasource';
import {
  SimklSyncItem,
  type SimklItemStatus,
} from '@server/entity/SimklSyncItem';
import type {
  WatchlistItem,
  WatchlistResponse,
} from '@server/interfaces/api/discoverInterfaces';
import { createTmdbWithRegionLanguage } from '@server/lib/discover/tmdb';
import {
  hasDiscoverTmdbId,
  omitUnmappedDiscoverItems,
  shouldHideUnmappedFromQuery,
} from '@server/lib/discover/unmapped';
import { recordMappingGap } from '@server/lib/mapping/gaps';
import {
  catalogCandidates,
  hydrateSimklCandidates,
  paginateWatchlist,
  resolveSimklCandidates,
  simklPosterUrl,
  type ResolvedSimklItem,
  type SimklCandidate,
  type SimklTmdbResolvers,
} from '@server/lib/simklCatalog';
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

function toSyncCandidate(item: SimklSyncItem): SimklCandidate {
  const mediaType = item.simklType === 'movie' ? 'movie' : 'tv';
  const image = simklPosterUrl(item.posterPath);
  const tmdbId = hasDiscoverTmdbId(item.tmdbId) ? item.tmdbId : undefined;
  const tvdbId =
    typeof item.tvdbId === 'number' && item.tvdbId > 0
      ? item.tvdbId
      : undefined;
  return {
    isAnime: item.simklType === 'anime',
    ids: {
      ...(tmdbId ? { tmdb: tmdbId } : {}),
      ...(tvdbId ? { tvdb: tvdbId } : {}),
    },
    item: {
      id: (tmdbId ?? Number(item.simklId)) || 0,
      ratingKey: `simkl-${item.simklType}-${item.simklId}`,
      ...(tmdbId ? { tmdbId } : {}),
      mediaType,
      title: item.title,
      source: 'simkl',
      sourceId: item.simklId,
      sourceUrl: sourceUrl(item),
      ...(image ? { image } : {}),
    },
  };
}

const loadSimklTitle =
  (client: SimklAPI) => (kind: 'movies' | 'tv' | 'anime', simklId: string) =>
    client.getTitle(kind, simklId);

/**
 * `/find` is scoped to the declared media type and `confirm` may only reject,
 * so no resolution can be derived from an id merely existing in the opposite
 * TMDB namespace.
 */
export const tmdbResolvers = (tmdb: TheMovieDb): SimklTmdbResolvers => ({
  findByExternalId: async (source, externalId, mediaType) => {
    if (source === 'tvdb' && mediaType === 'movie') return [];
    try {
      const found =
        source === 'imdb'
          ? await tmdb.getByExternalId({ externalId, type: 'imdb' })
          : await tmdb.getByExternalId({
              externalId: Number(externalId),
              type: 'tvdb',
            });
      const results =
        mediaType === 'movie' ? found.movie_results : found.tv_results;
      return results.map((result) => result.id).filter((id) => id > 0);
    } catch {
      return [];
    }
  },
  confirm: async (mediaType, tmdbId) => {
    try {
      if (mediaType === 'movie') await tmdb.getMovie({ movieId: tmdbId });
      else await tmdb.getTvShow({ tvId: tmdbId });
      return true;
    } catch {
      return false;
    }
  },
});

/** Annotate each tile with how (or whether) it resolved, for the UI and repair queue. */
function withMappingState(resolved: ResolvedSimklItem[]): WatchlistItem[] {
  return resolved.map(({ item, resolution }) => ({
    ...item,
    mappingState: {
      state: hasDiscoverTmdbId(item.tmdbId)
        ? ('mapped' as const)
        : resolution.ambiguous
          ? ('ambiguous' as const)
          : ('unmapped' as const),
      sourceKey: resolution.sourceKey,
      namespace: 'simkl',
      ...(item.sourceId ? { externalId: item.sourceId } : {}),
    },
  }));
}

function recordSimklGaps(
  resolved: ResolvedSimklItem[],
  discoverSource: string
): void {
  for (const { item, resolution, candidate } of resolved) {
    if (hasDiscoverTmdbId(item.tmdbId) || !item.sourceId) continue;
    recordMappingGap({
      namespace: 'simkl',
      externalId: item.sourceId,
      title: item.title,
      mediaType: item.mediaType,
      discoverSource,
      reason: resolution.ambiguous ? 'ambiguous' : 'unresolved',
      sourceKey: resolution.sourceKey,
      ...(candidate.ids.tmdb
        ? {
            rejectedTarget: `${item.mediaType === 'movie' ? 'tmdb_movie' : 'tmdb_show'}:${candidate.ids.tmdb}`,
          }
        : {}),
    });
  }
}

async function mappedCatalogPage(
  candidates: SimklCandidate[],
  page: number,
  hideUnmapped: boolean,
  discoverSource: string,
  tmdb: TheMovieDb = createTmdbWithRegionLanguage()
) {
  const paged = paginateWatchlist(candidates, page);
  const hydrated = await hydrateSimklCandidates(
    paged.results,
    loadSimklTitle(new SimklAPI())
  );
  const resolved = await resolveSimklCandidates(hydrated, tmdbResolvers(tmdb));
  recordSimklGaps(resolved, discoverSource);
  return {
    page: paged.page,
    hasMore: paged.hasMore,
    results: omitUnmappedDiscoverItems(
      withMappingState(resolved),
      hideUnmapped
    ),
  };
}

const trendingFile = (mediaType: string, period: string): string => {
  const window = period === 'day' ? 'today' : period;
  if (mediaType === 'movie')
    return `/discover/trending/movies/${window}_100.json`;
  if (mediaType === 'tv') return `/discover/trending/tv/${window}_100.json`;
  if (mediaType === 'anime')
    return `/discover/trending/anime/${window}_100.json`;
  return `/discover/trending/${window}_100.json`;
};

simklDiscoverRoutes.get('/library', async (req, res, next) => {
  if (!req.user?.id) return next({ status: 401, message: 'Unauthorized' });
  const userId = req.user.id;
  const result = await syncSimklUser(
    userId,
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
    .where('item.userId = :userId', { userId })
    .andWhere('item.simklType IN (:...types)', { types })
    .andWhere(status ? 'item.status = :status' : '1=1', { status })
    .orderBy('item.addedAt', 'DESC', 'NULLS LAST')
    .getMany();
  const page = Math.max(1, Number(req.query.page) || 1);
  const start = (page - 1) * 20;
  const slice = rows.slice(start, start + 20).map(toSyncCandidate);
  const hydrated = await hydrateSimklCandidates(
    slice,
    loadSimklTitle(new SimklAPI())
  );
  const resolved = await resolveSimklCandidates(
    hydrated,
    tmdbResolvers(createTmdbWithRegionLanguage(req.user))
  );
  recordSimklGaps(resolved, 'simkl/library');
  const results = omitUnmappedDiscoverItems(
    withMappingState(resolved),
    shouldHideUnmappedFromQuery(req.query)
  );
  const repository = getRepository(SimklSyncItem);
  await Promise.all(
    results.map((item) =>
      hasDiscoverTmdbId(item.tmdbId) && item.sourceId
        ? repository
            .createQueryBuilder()
            .update()
            .set({ tmdbId: item.tmdbId })
            .where('simklId = :simklId AND userId = :userId', {
              simklId: item.sourceId,
              userId,
            })
            .execute()
        : Promise.resolve()
    )
  );
  return res.status(200).json({
    page,
    totalResults: rows.length,
    totalPages: Math.max(1, Math.ceil(rows.length / 20)),
    hasMore: start + 20 < rows.length,
    results,
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
    const payload = await new SimklAPI().getCdnCatalog(
      trendingFile(type, period)
    );
    return res.status(200).json({
      ...(await mappedCatalogPage(
        catalogCandidates([payload], type, 'simkl-public'),
        page,
        shouldHideUnmappedFromQuery(req.query),
        `simkl/trending/${type}`
      )),
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
    const payload = await new SimklAPI().getCatalog(
      `/${mediaType}/best/${filter}`
    );
    return res.status(200).json({
      ...(await mappedCatalogPage(
        catalogCandidates([payload], mediaType, 'simkl-best'),
        page,
        shouldHideUnmappedFromQuery(req.query),
        `simkl/best/${mediaType}`
      )),
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
    const window =
      String(req.query.window) === 'upcoming' ||
      String(req.query.window) === 'soon'
        ? 'soon'
        : 'new';
    const page = Math.max(1, Number(req.query.page) || 1);
    const payload = await new SimklAPI().getCatalog(
      `/${mediaType}/premieres/${window}`,
      { page, limit: 20 }
    );
    return res.status(200).json({
      ...(await mappedCatalogPage(
        catalogCandidates([payload], mediaType, 'simkl-premieres'),
        page,
        shouldHideUnmappedFromQuery(req.query),
        `simkl/premieres/${mediaType}`
      )),
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
