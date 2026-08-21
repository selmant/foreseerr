import AnilistAPI from '@server/api/anilist';
import type { WatchlistResponse } from '@server/interfaces/api/discoverInterfaces';
import { createAnilistAppClient } from '@server/lib/anilist';
import {
  collectUserListItems,
  listUserAniListLists,
  mapAnilistMediaList,
  matchesListName,
  paginateItems,
  toWatchlistItems,
} from '@server/lib/anilist/discover';
import { getAnilistUserContext } from '@server/lib/anilist/userContext';
import { handleAnilistDiscoverRouteError } from '@server/lib/discover/providerErrors';
import {
  omitUnmappedDiscoverItems,
  shouldHideUnmappedFromQuery,
} from '@server/lib/discover/unmapped';
import type { Request, Response } from 'express';
import { Router } from 'express';

const anilistDiscoverRoutes = Router();

function anilistResults(
  items: Parameters<typeof toWatchlistItems>[0],
  query: Request['query']
) {
  return omitUnmappedDiscoverItems(
    toWatchlistItems(items),
    shouldHideUnmappedFromQuery(query)
  );
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
    createAnilistAppClient();
    const page = req.query.page ? Number(req.query.page) : 1;
    const mediaPage = await fetchPage(new AnilistAPI(), page);
    const mapped = await mapAnilistMediaList(mediaPage.media);
    return res.status(200).json({
      page,
      hasMore: Boolean(mediaPage.pageInfo.hasNextPage),
      results: anilistResults(mapped, req.query),
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
  matcher: Parameters<typeof collectUserListItems>[2]
) {
  try {
    if (!req.user?.id) return next({ status: 401, message: 'Unauthorized' });
    const page = req.query.page ? Number(req.query.page) : 1;
    const { client, anilistUserId } = await getAnilistUserContext(req.user.id);
    const paged = paginateItems(
      await collectUserListItems(client, anilistUserId, matcher),
      page
    );
    return res.status(200).json({
      page: paged.page,
      hasMore: paged.hasMore,
      results: anilistResults(paged.results, req.query),
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

anilistDiscoverRoutes.get('/list', async (req, res, next) => {
  try {
    if (!req.user?.id) return next({ status: 401, message: 'Unauthorized' });
    const name = String(req.query.name ?? req.query.url ?? '').trim();
    if (!name)
      return next({ status: 400, message: 'name query parameter is required' });
    const page = req.query.page ? Number(req.query.page) : 1;
    const { client, anilistUserId } = await getAnilistUserContext(req.user.id);
    const paged = paginateItems(
      await collectUserListItems(client, anilistUserId, (list) =>
        matchesListName(list, name)
      ),
      page
    );
    return res.status(200).json({
      page: paged.page,
      hasMore: paged.hasMore,
      results: anilistResults(paged.results, req.query),
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
