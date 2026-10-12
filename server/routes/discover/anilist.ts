import AnilistAPI, {
  AnilistGraphQLError,
  PUBLIC_PAGE_CACHE_TTL_SECONDS,
} from '@server/api/anilist';
import type {
  WatchlistItem,
  WatchlistResponse,
} from '@server/interfaces/api/discoverInterfaces';
import { createAnilistDiscoverClient } from '@server/lib/anilist';
import {
  PROVIDER_ROW_CONCURRENCY,
  mapWithConcurrency,
} from '@server/lib/concurrency';
import {
  collectUserListMedia,
  listUserAniListLists,
  mapAnilistMediaList,
  mapAnilistMediaPage,
  matchesListName,
  parseAnilistListUrl,
  toWatchlistItems,
} from '@server/lib/anilist/discover';
import { getAnilistUserContext } from '@server/lib/anilist/userContext';
import { annotateProviderActiveRequests } from '@server/lib/discover/mediaResults';
import { withTmdbPoster } from '@server/lib/discover/posters';
import { handleAnilistDiscoverRouteError } from '@server/lib/discover/providerErrors';
import { cachedProviderRow } from '@server/lib/discover/rowCache';
import {
  omitUnmappedDiscoverItems,
  recordUnmappedItems,
  shouldHideUnmappedFromQuery,
} from '@server/lib/discover/unmapped';
import { confirmOrRepair } from '@server/lib/discover/validity';
import axios from 'axios';
import type { Request, Response } from 'express';
import { Router } from 'express';

const anilistDiscoverRoutes = Router();

/** The tiles of `items`, confirmed and drawn: the part of a row worth storing. */
async function anilistTiles(
  items: Parameters<typeof toWatchlistItems>[0],
  discoverSource: string
): Promise<WatchlistItem[]> {
  // Dataset entries go stale, and a mapping that once pointed somewhere real
  // can outlive the TMDB record it names.
  return mapWithConcurrency(
    toWatchlistItems(items),
    PROVIDER_ROW_CONCURRENCY,
    async (item) => {
      const confirmed =
        item.tmdbId && item.mediaType
          ? await confirmOrRepair(
              {
                tmdbId: item.tmdbId,
                mediaType: item.mediaType,
                title: item.title,
                refs: item.sourceId
                  ? [{ ns: 'anilist' as const, id: item.sourceId }]
                  : [],
              },
              { discoverSource }
            )
          : undefined;
      return withTmdbPoster({
        ...item,
        // Clients open tiles by `id`, so a repaired id replaces it too. A dead
        // id that could not be repaired falls back to the AniList id, as an
        // unmapped tile's `id` does.
        ...(confirmed
          ? {
              tmdbId: confirmed.tmdbId,
              id: confirmed.tmdbId ?? Number(item.sourceId),
              ...(confirmed.mediaType
                ? { mediaType: confirmed.mediaType }
                : {}),
            }
          : {}),
        mappingState: confirmed?.mappingState ?? {
          state: item.tmdbId ? ('mapped' as const) : ('unmapped' as const),
          namespace: 'anilist',
          ...(item.sourceId ? { externalId: item.sourceId } : {}),
        },
      });
    }
  );
}

/** What every serve does with stored tiles: sightings, `hideUnmapped`, requests. */
async function serveAnilistTiles(tiles: WatchlistItem[], req: Request) {
  recordUnmappedItems(tiles, {
    namespace: 'anilist',
    discoverSource: `anilist${req.path}`,
  });
  return annotateProviderActiveRequests(
    omitUnmappedDiscoverItems(tiles, shouldHideUnmappedFromQuery(req.query))
  );
}

async function anilistResults(
  items: Parameters<typeof toWatchlistItems>[0],
  req: Request
) {
  return serveAnilistTiles(
    await anilistTiles(items, `anilist${req.path}`),
    req
  );
}

/**
 * A public page's row key. The user's own client answers when one is linked,
 * and the seasonal rows name their season so a new one is not served stale.
 */
export function anilistPublicRowKey(
  path: string,
  userId: number | undefined,
  page: number,
  now = new Date()
): string {
  const season =
    path === '/season'
      ? AnilistAPI.currentSeason(now)
      : path === '/next-season'
        ? AnilistAPI.nextSeason(now)
        : undefined;
  return [
    `anilist${path}`,
    `user:${userId ?? 0}`,
    season ? `${season.season}-${season.year}` : '',
    `page:${page}`,
  ].join('|');
}

async function publicPage(
  req: Request,
  res: Response,
  next: (err?: unknown) => void,
  fetchPage: (
    client: AnilistAPI,
    page: number
  ) => Promise<Awaited<ReturnType<AnilistAPI['getTrending']>>>,
  errorMessage: string
) {
  try {
    const page = req.query.page ? Number(req.query.page) : 1;
    const row = await cachedProviderRow(
      anilistPublicRowKey(req.path, req.user?.id, page),
      PUBLIC_PAGE_CACHE_TTL_SECONDS,
      async () => {
        const client = await createAnilistDiscoverClient(req.user?.id);
        const mediaPage = await fetchPage(client, page);
        return {
          hasMore: Boolean(mediaPage.pageInfo.hasNextPage),
          tiles: await anilistTiles(
            await mapAnilistMediaList(mediaPage.media),
            `anilist${req.path}`
          ),
        };
      }
    );
    return res.status(200).json({
      page,
      hasMore: row.hasMore,
      results: await serveAnilistTiles(row.tiles, req),
    } satisfies WatchlistResponse);
  } catch (error) {
    return handleAnilistDiscoverRouteError(error, next, errorMessage);
  }
}

const publicRoutes: [
  string,
  (client: AnilistAPI, page: number) => ReturnType<AnilistAPI['getTrending']>,
  string,
][] = [
  [
    '/trending',
    (client, page) => client.getTrending(page),
    'Unable to retrieve AniList trending anime.',
  ],
  [
    '/season',
    (client, page) => client.getSeason(page),
    'Unable to retrieve AniList seasonal anime.',
  ],
  [
    '/popular',
    (client, page) => client.getPopular(page),
    'Unable to retrieve AniList popular anime.',
  ],
  [
    '/top',
    (client, page) => client.getTop(page),
    'Unable to retrieve AniList top anime.',
  ],
  [
    '/next-season',
    (client, page) => client.getNextSeason(page),
    'Unable to retrieve AniList next-season anime.',
  ],
];

for (const [path, fetchPage, errorMessage] of publicRoutes) {
  anilistDiscoverRoutes.get(path, (req, res, next) =>
    publicPage(req, res, next, fetchPage, errorMessage)
  );
}

async function userList(
  req: Request,
  res: Response,
  next: (err?: unknown) => void,
  matcher: Parameters<typeof collectUserListMedia>[2]
) {
  try {
    if (!req.user?.id) return next({ status: 401, message: 'Unauthorized' });
    const page = req.query.page ? Number(req.query.page) : 1;
    const { client, anilistUserId } = await getAnilistUserContext(req.user.id);
    // Only the requested page is mapped, not the whole list.
    const paged = await mapAnilistMediaPage(
      await collectUserListMedia(client, anilistUserId, matcher),
      page
    );
    return res.status(200).json({
      page: paged.page,
      hasMore: paged.hasMore,
      results: await anilistResults(paged.results, req),
    } satisfies WatchlistResponse);
  } catch (error) {
    return handleAnilistDiscoverRouteError(
      error,
      next,
      'Unable to retrieve AniList list.'
    );
  }
}

anilistDiscoverRoutes.get('/watching', (req, res, next) =>
  userList(
    req,
    res,
    next,
    (list) =>
      list.status === 'CURRENT' || list.name.toLowerCase() === 'watching'
  )
);
anilistDiscoverRoutes.get('/planning', (req, res, next) =>
  userList(
    req,
    res,
    next,
    (list) =>
      list.status === 'PLANNING' || list.name.toLowerCase() === 'planning'
  )
);
anilistDiscoverRoutes.get('/completed', (req, res, next) =>
  userList(
    req,
    res,
    next,
    (list) =>
      list.status === 'COMPLETED' || list.name.toLowerCase() === 'completed'
  )
);
anilistDiscoverRoutes.get('/paused', (req, res, next) =>
  userList(
    req,
    res,
    next,
    (list) => list.status === 'PAUSED' || list.name.toLowerCase() === 'paused'
  )
);
anilistDiscoverRoutes.get('/dropped', (req, res, next) =>
  userList(
    req,
    res,
    next,
    (list) => list.status === 'DROPPED' || list.name.toLowerCase() === 'dropped'
  )
);

anilistDiscoverRoutes.get('/lists', async (req, res, next) => {
  try {
    if (!req.user?.id) return next({ status: 401, message: 'Unauthorized' });
    const { client, anilistUserId } = await getAnilistUserContext(req.user.id);
    return res.status(200).json({
      results: await listUserAniListLists(client, anilistUserId),
    });
  } catch (error) {
    return handleAnilistDiscoverRouteError(
      error,
      next,
      'Unable to retrieve AniList lists.'
    );
  }
});

async function publicList(
  req: Request,
  res: Response,
  next: (err?: unknown) => void,
  url: string
) {
  let owner: ReturnType<typeof parseAnilistListUrl>;
  try {
    owner = parseAnilistListUrl(url);
  } catch (error) {
    return next({
      status: 400,
      message: error instanceof Error ? error.message : 'Invalid list URL',
    });
  }
  try {
    const page = req.query.page ? Number(req.query.page) : 1;
    const client = await createAnilistDiscoverClient(req.user?.id);
    const { listName } = owner;
    const paged = await mapAnilistMediaPage(
      await collectUserListMedia(client, owner.userName, (list) =>
        listName ? matchesListName(list, listName) : true
      ),
      page
    );
    return res.status(200).json({
      page: paged.page,
      hasMore: paged.hasMore,
      results: await anilistResults(paged.results, req),
      title: listName
        ? `${listName} · ${owner.userName}`
        : `${owner.userName}'s Anime List`,
    });
  } catch (error) {
    // AniList answers an unknown or private user with a 404 or a plain
    // GraphQL error rather than anything more specific.
    if (
      error instanceof AnilistGraphQLError ||
      (axios.isAxiosError(error) && error.response?.status === 404)
    ) {
      return next({
        status: 404,
        message: 'AniList user not found, or their list is private.',
      });
    }
    return handleAnilistDiscoverRouteError(
      error,
      next,
      'Unable to retrieve AniList list.'
    );
  }
}

anilistDiscoverRoutes.get('/list', async (req, res, next) => {
  const url = String(req.query.url ?? '').trim();
  if (url) return publicList(req, res, next, url);
  try {
    if (!req.user?.id) return next({ status: 401, message: 'Unauthorized' });
    const name = String(req.query.name ?? '').trim();
    if (!name)
      return next({ status: 400, message: 'name query parameter is required' });
    const page = req.query.page ? Number(req.query.page) : 1;
    const { client, anilistUserId } = await getAnilistUserContext(req.user.id);
    const paged = await mapAnilistMediaPage(
      await collectUserListMedia(client, anilistUserId, (list) =>
        matchesListName(list, name)
      ),
      page
    );
    return res.status(200).json({
      page: paged.page,
      hasMore: paged.hasMore,
      results: await anilistResults(paged.results, req),
      title: name,
    });
  } catch (error) {
    return handleAnilistDiscoverRouteError(
      error,
      next,
      'Unable to retrieve AniList list.'
    );
  }
});

export default anilistDiscoverRoutes;
