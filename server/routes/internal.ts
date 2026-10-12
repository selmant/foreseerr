import animeList from '@server/api/animelist';
import { getMetadataProvider } from '@server/api/metadata';
import TheMovieDb from '@server/api/themoviedb';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { cancelManagedJob, executeManagedJob } from '@server/job/execution';
import {
  scheduledJobs,
  startDesktopCatchUp,
  startJobs,
} from '@server/job/schedule';
import { disconnectAllAnilistLinks } from '@server/lib/anilist';
import { mapAnilistMediaList } from '@server/lib/anilist/discover';
import {
  PROVIDER_ROW_CONCURRENCY,
  mapWithConcurrency,
} from '@server/lib/concurrency';
import cacheManager, {
  getMemoryCacheStats,
  type AvailableCacheIds,
} from '@server/lib/cache';
import { withTmdbPosters } from '@server/lib/discover/posters';
import { resolveDiscoverItems } from '@server/lib/discover/resolveItems';
import { createTmdbWithRegionLanguage } from '@server/lib/discover/tmdb';
import {
  hasDiscoverTmdbId,
  recordUnmappedItems,
} from '@server/lib/discover/unmapped';
import { confirmOrRepair } from '@server/lib/discover/validity';
import downloadTracker from '@server/lib/downloadtracker';
import ImageProxy from '@server/lib/imageproxy';
import { IMAGE_CACHE_STAT_SOURCES } from '@server/lib/imageproxySources';
import {
  clearIntegrationHealthCache,
  getIntegrationHealth,
} from '@server/lib/integrationHealth';
import { jsonSafeClone } from '@server/lib/jsonSafe';
import {
  datasetDefinition,
  listDatasets,
  loadActiveGenerations,
  refreshDataset,
  setDatasetEnabled,
} from '@server/lib/mapping/datasets';
import { clearEdgeCache } from '@server/lib/mapping/edges';
import { snapshotPackProgress } from '@server/lib/mapping/progress';
import { flushMisses, recordMiss } from '@server/lib/mapping/resolutions';
import { invalidateResolutions } from '@server/lib/mapping/resolve';
import {
  clearAnilistSyncCache,
  invalidateUserAnilistSyncCache,
} from '@server/lib/mediaActions/anilistSyncCache';
import {
  clearSyncCache,
  invalidateUserSyncCache,
} from '@server/lib/mediaActions/syncCache';
import { clearMdblistProviderState } from '@server/lib/ratings';
import releaseCalendarSync from '@server/lib/releases/sync';
import { jellyfinFullScanner } from '@server/lib/scanners/jellyfin';
import { plexFullScanner } from '@server/lib/scanners/plex';
import Settings, { getSettings } from '@server/lib/settings';
import { disconnectAllSimklLinks } from '@server/lib/simkl';
import {
  resolveSimklCandidates,
  type ResolvedSimklItem,
  type SimklCandidate,
} from '@server/lib/simklCatalog';
import { syncSimklUser } from '@server/lib/simklSync';
import {
  disconnectAllTraktLinks,
  refreshUserTraktTokens,
} from '@server/lib/trakt';
import { loadCombinedWatchedIdSets } from '@server/lib/trakt/hideWatched';
import {
  confirmTraktTmdbIds,
  hydrateTraktTmdbIds,
} from '@server/lib/trakt/mapping';
import logger from '@server/logger';
import { checkAvatarChanged } from '@server/routes/avatarproxy';
import {
  tmdbResolvers,
  toSimklWatchlistItems,
} from '@server/routes/discover/simkl';
import { dnsCache } from '@server/utils/dnsCache';
import { timingSafeEqual } from 'crypto';
import { Router } from 'express';
import { rescheduleJob } from 'node-schedule';

/**
 * Process state the Rust backend cannot read from the database or
 * settings.json. Mounted outside `/api`, so neither the OpenAPI validator
 * nor the session middleware sees it; the API key is the only credential.
 */
const internalRoutes = Router();

const apiKeyMatches = (header: string | undefined): boolean => {
  const expected = getSettings().main.apiKey;
  if (!header || !expected) {
    return false;
  }
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

internalRoutes.use((req, res, next) => {
  if (!apiKeyMatches(req.header('X-API-Key'))) {
    res.status(403).json({ message: 'Forbidden' });
    return;
  }
  next();
});

internalRoutes.get('/downloads', (_req, res) => {
  res.status(200).json(downloadTracker.snapshot());
});

// Rust wrote settings.json; read it again so Node's routes and jobs see
// the same settings.
// `load()` merges the file into the in-memory document, which would keep
// keys Rust removed; load a fresh copy and swap its document in instead.
internalRoutes.post('/settings/reload', async (_req, res) => {
  const fresh = await new Settings().load();
  await getSettings().load(
    (fresh as unknown as { data: Parameters<Settings['load']>[0] }).data
  );
  res.status(204).end();
});

// Side effects of the settings writes that live in Node's process (caches,
// and account disconnects that also drop in-memory sync caches). Rust calls
// this after saving settings.json, with the effects in the order Node's
// handler runs them. Counting effects report their count.
internalRoutes.post('/settings/effects', async (req, res) => {
  const effects: unknown = req.body?.effects;
  if (!Array.isArray(effects)) {
    res.status(400).json({ message: 'effects must be an array' });
    return;
  }
  const results: Record<string, number> = {};
  for (const effect of effects) {
    switch (effect) {
      case 'clearIntegrationHealthCache':
        clearIntegrationHealthCache();
        break;
      case 'clearMdblistProviderState':
        clearMdblistProviderState();
        break;
      case 'clearSyncCache':
        clearSyncCache();
        break;
      case 'clearAnilistSyncCache':
        clearAnilistSyncCache();
        break;
      case 'disconnectAllTraktLinks':
        results[effect] = await disconnectAllTraktLinks();
        break;
      case 'disconnectAllSimklLinks':
        results[effect] = await disconnectAllSimklLinks();
        break;
      case 'disconnectAllAnilistLinks':
        results[effect] = await disconnectAllAnilistLinks();
        break;
      default:
        res.status(400).json({ message: `Unknown effect: ${String(effect)}` });
        return;
    }
  }
  res.status(200).json(results);
});

// Rust links and unlinks Trakt/AniList accounts in the database; drop the
// user's in-memory media-action sync snapshot as Node's handlers do.
internalRoutes.post<{ id: string; provider: string }>(
  '/user/:id/sync-cache/:provider/invalidate',
  (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId)) {
      res.status(400).json({ message: 'Invalid user id' });
      return;
    }
    switch (req.params.provider) {
      case 'trakt':
        invalidateUserSyncCache(userId);
        break;
      case 'anilist':
        invalidateUserAnilistSyncCache(userId);
        break;
      default:
        res.status(404).json({ message: 'Unknown provider' });
        return;
    }
    res.status(204).end();
  }
);

// The first Plex/Jellyfin sign-in created the admin: start the scheduler
// as routes/auth.ts does. Rust has already had Node reload settings.json.
internalRoutes.post('/jobs/start', (_req, res) => {
  startJobs();
  startDesktopCatchUp();
  res.status(204).end();
});

// The login handlers' avatar refresh: checkAvatarChanged(user) and, when
// the image changed, the avatar save, run on the user as findOne loads it.
// `overrides` are properties the handler's own entity held stale (the
// known-user /auth/jellyfin branch writes with update() and keeps the
// entity it loaded before; TypeORM's save() then writes those stale
// values back, updatedAt included). Answers what the handler's entity
// ends up with.
internalRoutes.post('/auth/avatar-check', async (req, res, next) => {
  try {
    const { userId, overrides } = (req.body ?? {}) as {
      userId: number;
      overrides?: {
        avatar?: string;
        jellyfinUsername?: string | null;
        username?: string | null;
        updatedAt?: string | null;
      };
    };
    const userRepository = getRepository(User);
    const user = await userRepository.findOne({ where: { id: userId } });
    if (!user) {
      res.status(404).json({ message: 'User not found' });
      return;
    }
    if (overrides && typeof overrides === 'object') {
      // Only those properties: the body isn't validated.
      for (const key of ['avatar', 'jellyfinUsername', 'username'] as const) {
        if (key in overrides) {
          Object.assign(user, { [key]: overrides[key] });
        }
      }
      const { updatedAt } = overrides;
      if (updatedAt !== undefined) {
        user.updatedAt =
          updatedAt === null ? (null as unknown as Date) : new Date(updatedAt);
      }
    }
    try {
      const { changed } = await checkAvatarChanged(user);
      if (changed) {
        user.avatar = `/avatarproxy/${user.jellyfinUserId}?v=${user.avatarVersion}`;
        await userRepository.save(user);
        logger.debug('Avatar updated during login', {
          userId: user.id,
          jellyfinUserId: user.jellyfinUserId,
        });
      }
    } catch (error) {
      logger.error('Error handling avatar during login', {
        label: 'Auth',
        errorMessage: (error as Error).message,
      });
    }
    res.status(200).json({ avatar: user.avatar, updatedAt: user.updatedAt });
  } catch (e) {
    next(e);
  }
});

const internalErrorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

// Same as jobNextExecutionIso in routes/settings/index.ts (not exported).
const internalJobNextExecutionIso = (next: unknown): string | null => {
  if (!next) return null;
  if (next instanceof Date) return next.toISOString();
  if (
    typeof next === 'object' &&
    next !== null &&
    'toJSDate' in next &&
    typeof (next as { toJSDate: () => Date }).toJSDate === 'function'
  ) {
    return (next as { toJSDate: () => Date }).toJSDate().toISOString();
  }
  if (
    typeof next === 'object' &&
    next !== null &&
    'toISO' in next &&
    typeof (next as { toISO: () => string | null }).toISO === 'function'
  ) {
    return (next as { toISO: () => string | null }).toISO();
  }
  const parsed = new Date(next as string | number);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

type InternalScheduledJob = (typeof scheduledJobs)[number];

// What run/cancel/schedule answer: `nextInvocation()` as is, the way
// those routes serialise it (unlike GET /jobs, which converts it).
const internalJobSnapshot = (job: InternalScheduledJob) =>
  jsonSafeClone({
    id: job.id,
    name: job.name,
    type: job.type,
    interval: job.interval,
    cronSchedule: job.cronSchedule,
    nextExecutionTime: job.job.nextInvocation(),
    running: job.running ? job.running() : false,
  });

const internalFindJob = (id: string): InternalScheduledJob | undefined =>
  scheduledJobs.find((job) => job.id === id);

// GET /settings/jobs, as Node shapes it.
internalRoutes.get('/jobs', (_req, res) => {
  res.status(200).json(
    jsonSafeClone(
      scheduledJobs.map((job) => ({
        id: job.id,
        name: job.name,
        type: job.type,
        interval: job.interval,
        cronSchedule: job.cronSchedule,
        nextExecutionTime: internalJobNextExecutionIso(
          job.job.nextInvocation()
        ),
        running: job.running ? job.running() : false,
      }))
    )
  );
});

internalRoutes.post('/jobs/:jobId/run', (req, res) => {
  const job = internalFindJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ message: 'Job not found.' });
    return;
  }
  job.job.invoke();
  res.status(200).json(internalJobSnapshot(job));
});

internalRoutes.post('/jobs/:jobId/cancel', (req, res) => {
  const job = internalFindJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ message: 'Job not found.' });
    return;
  }
  job.cancelFn?.();
  res.status(200).json(internalJobSnapshot(job));
});

// Reschedules only; Rust writes settings.jobs[id].schedule afterwards.
internalRoutes.post('/jobs/:jobId/schedule', (req, res) => {
  const job = internalFindJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ message: 'Job not found.' });
    return;
  }
  const schedule = req.body?.schedule;
  if (typeof schedule !== 'string') {
    res.status(400).json({ message: 'schedule must be a string.' });
    return;
  }
  if (!rescheduleJob(job.job, schedule)) {
    res.status(200).json({ rescheduled: false });
    return;
  }
  job.cronSchedule = schedule;
  res.status(200).json({ rescheduled: true, job: internalJobSnapshot(job) });
});

const internalScanner = (server: string) =>
  server === 'plex'
    ? { id: 'plex-full-scan', scanner: plexFullScanner }
    : server === 'jellyfin'
      ? { id: 'jellyfin-full-scan', scanner: jellyfinFullScanner }
      : undefined;

internalRoutes.get('/scanners/:server', (req, res) => {
  const found = internalScanner(req.params.server);
  if (!found) {
    res.status(404).json({ message: 'Unknown scanner.' });
    return;
  }
  res.status(200).json(jsonSafeClone(found.scanner.status()));
});

// body: { action: 'cancel' | 'start' | null }
internalRoutes.post('/scanners/:server', (req, res) => {
  const found = internalScanner(req.params.server);
  if (!found) {
    res.status(404).json({ message: 'Unknown scanner.' });
    return;
  }
  const action = req.body?.action;
  if (action === 'cancel') {
    cancelManagedJob(found.id);
    found.scanner.cancel();
  } else if (action === 'start') {
    void executeManagedJob(found.id, 'heavy', () => found.scanner.run());
  }
  res.status(200).json(jsonSafeClone(found.scanner.status()));
});

// The parts of GET /settings/cache that live in Node.
internalRoutes.get('/cache', async (_req, res) => {
  try {
    const apiCaches = Object.values(cacheManager.getAllCaches()).map(
      (cache) => ({
        id: cache.id,
        name: cache.name,
        stats: cache.getStats(),
      })
    );
    const [imageStats, ...groupStats] = await Promise.all([
      ImageProxy.getCombinedStats(),
      ...IMAGE_CACHE_STAT_SOURCES.map((key) => ImageProxy.getImageStats(key)),
    ]);
    const imageCache = Object.fromEntries(
      IMAGE_CACHE_STAT_SOURCES.map((key, index) => [key, groupStats[index]])
    );
    res.status(200).json(
      jsonSafeClone({
        apiCaches,
        imageCache,
        memory: getMemoryCacheStats(),
        images: imageStats,
        dnsCache: {
          stats: dnsCache?.getStats(),
          entries: dnsCache?.getCacheEntries(),
        },
      })
    );
  } catch (e) {
    res.status(500).json({ message: internalErrorMessage(e) });
  }
});

internalRoutes.post('/cache/:cacheId/flush', (req, res) => {
  const caches = cacheManager.getAllCaches();
  if (!Object.prototype.hasOwnProperty.call(caches, req.params.cacheId)) {
    res.status(404).json({ message: 'Cache not found.' });
    return;
  }
  cacheManager.getCache(req.params.cacheId as AvailableCacheIds).flush();
  res.status(204).end();
});

internalRoutes.post('/cache/dns/:dnsEntry/flush', (req, res) => {
  if (!dnsCache) {
    res.status(404).json({ message: 'Cache not found.' });
    return;
  }
  dnsCache.clear(req.params.dnsEntry);
  res.status(204).end();
});

internalRoutes.get('/integrations/health', async (_req, res) => {
  try {
    res.status(200).json(jsonSafeClone(await getIntegrationHealth()));
  } catch (e) {
    res.status(500).json({ message: internalErrorMessage(e) });
  }
});

internalRoutes.post('/integrations/health/refresh', async (_req, res) => {
  try {
    clearIntegrationHealthCache();
    res.status(200).json(jsonSafeClone(await getIntegrationHealth()));
  } catch (e) {
    res.status(500).json({ message: internalErrorMessage(e) });
  }
});

internalRoutes.post('/integrations/health/clear', (_req, res) => {
  clearIntegrationHealthCache();
  res.status(204).end();
});

// Batched miss sightings are written before Rust reads the unmapped list.
internalRoutes.post('/mapping/flush', async (_req, res) => {
  try {
    await flushMisses();
    res.status(204).end();
  } catch (e) {
    res.status(500).json({ message: internalErrorMessage(e) });
  }
});

// GET /settings/mapping/status: flush sightings, snapshot refresh progress,
// list (and seed) the dataset rows. Rust counts the resolutions itself.
internalRoutes.get('/mapping/status', async (_req, res) => {
  try {
    await flushMisses();
    const refreshes = snapshotPackProgress();
    const datasets = await listDatasets();
    res.status(200).json(jsonSafeClone({ refreshes, datasets }));
  } catch (e) {
    res.status(500).json({ message: internalErrorMessage(e) });
  }
});

// Rust wrote or deleted resolutions; drop the lookup caches.
internalRoutes.post('/mapping/invalidate', (_req, res) => {
  invalidateResolutions();
  res.status(204).end();
});
// Rust refreshed or toggled a mapping dataset: reload the generations
// Node's lookups follow and drop the caches onDatasetsChanged would clear.
internalRoutes.post('/mapping/datasets/changed', async (_req, res) => {
  try {
    await loadActiveGenerations({ force: true });
    clearEdgeCache();
    invalidateResolutions();
    res.status(204).end();
  } catch (e) {
    res.status(500).json({ message: internalErrorMessage(e) });
  }
});

internalRoutes.post('/mapping/datasets/:key', async (req, res) => {
  const { key } = req.params;
  if (!datasetDefinition(key) || typeof req.body?.enabled !== 'boolean') {
    res.status(400).json({ message: 'Unknown dataset or bad body.' });
    return;
  }
  try {
    const dataset = await setDatasetEnabled(key, req.body.enabled);
    if (req.body.enabled && process.env.NODE_ENV !== 'test') {
      void refreshDataset(key);
    }
    res.status(200).json({ dataset: jsonSafeClone(dataset) ?? null });
  } catch (e) {
    res.status(500).json({ message: internalErrorMessage(e) });
  }
});

internalRoutes.post('/mapping/datasets/:key/refresh', async (req, res) => {
  const { key } = req.params;
  if (!datasetDefinition(key)) {
    res.status(400).json({ message: 'Unknown dataset.' });
    return;
  }
  try {
    res
      .status(200)
      .json(jsonSafeClone(await refreshDataset(key, { force: true })));
  } catch (e) {
    res.status(500).json({ message: internalErrorMessage(e) });
  }
});

// ---- Rust library scanners ----

// animeList.sync() (ensureMappingLayer). 204 when done; a thrown error
// becomes a 500, which the Rust Jellyfin scan treats as "Sync interrupted".
internalRoutes.post('/animelist/sync', async (_req, res) => {
  try {
    await animeList.sync();
    return res.status(204).end();
  } catch (e) {
    return res.status(500).json({ message: internalErrorMessage(e) });
  }
});

// animeList.getFromAnidbId(id) → { item: AnidbItem | null }
internalRoutes.get('/animelist/anidb/:id', async (req, res) => {
  try {
    const item = await animeList.getFromAnidbId(Number(req.params.id));
    return res.status(200).json({ item: item ?? null });
  } catch (e) {
    return res.status(500).json({ message: internalErrorMessage(e) });
  }
});

// animeList.getSpecialEpisode(tvdbId, episode) → { item: AnidbItem | null }
internalRoutes.get('/animelist/special/:tvdbId/:episode', async (req, res) => {
  try {
    const item = await animeList.getSpecialEpisode(
      Number(req.params.tvdbId),
      Number(req.params.episode)
    );
    return res.status(200).json({ item: item ?? null });
  } catch (e) {
    return res.status(500).json({ message: internalErrorMessage(e) });
  }
});

// getMetadataProvider(kind).getTvShow({ tvId }) when the provider isn't
// TMDB → { show } ({ show: null } when it is TMDB).
internalRoutes.get('/metadata/tv/:kind/:tvId', async (req, res) => {
  try {
    const kind = req.params.kind === 'anime' ? 'anime' : 'tv';
    const provider = await getMetadataProvider(kind);
    if (provider instanceof TheMovieDb) {
      return res.status(200).json({ show: null });
    }
    const show = await provider.getTvShow({ tvId: Number(req.params.tvId) });
    return res.status(200).json({ show });
  } catch (e) {
    return res.status(500).json({ message: internalErrorMessage(e) });
  }
});

// ---- Rust /discover routes ----

// confirmOrRepair(item, options) for each item, a few at a time as the routes do.
// `null` stands for "the id is fine" (undefined).
internalRoutes.post('/mapping/confirm', async (req, res, next) => {
  try {
    const { items, options } = req.body ?? {};
    const results = await mapWithConcurrency(
      (items ?? []) as Parameters<typeof confirmOrRepair>[0][],
      PROVIDER_ROW_CONCURRENCY,
      (item) => confirmOrRepair(item, options ?? {})
    );
    res.status(200).json(results.map((r) => r ?? null));
  } catch (e) {
    next(e);
  }
});

internalRoutes.post('/mapping/resolve-items', async (req, res, next) => {
  try {
    const { items, options } = req.body ?? {};
    res.status(200).json(await resolveDiscoverItems(items ?? [], options));
  } catch (e) {
    next(e);
  }
});

internalRoutes.post('/mapping/posters', async (req, res, next) => {
  try {
    res.status(200).json(await withTmdbPosters(req.body?.items ?? []));
  } catch (e) {
    next(e);
  }
});

internalRoutes.post('/mapping/unmapped', (req, res) => {
  const { items, options } = req.body ?? {};
  recordUnmappedItems(items ?? [], options ?? {});
  res.status(204).end();
});

// hydrateTraktTmdbIds, then (options.confirm) confirmTraktTmdbIds.
internalRoutes.post('/mapping/trakt-ids', async (req, res, next) => {
  try {
    const { items, options } = req.body ?? {};
    const discoverSource = options?.discoverSource ?? 'trakt';
    const hydrated = await hydrateTraktTmdbIds(items ?? [], {
      discoverSource,
    });
    res
      .status(200)
      .json(
        options?.confirm
          ? await confirmTraktTmdbIds(hydrated, { discoverSource })
          : hydrated
      );
  } catch (e) {
    next(e);
  }
});

internalRoutes.post('/mapping/anilist-media', async (req, res, next) => {
  try {
    res.status(200).json(await mapAnilistMediaList(req.body?.media ?? []));
  } catch (e) {
    next(e);
  }
});

internalRoutes.get('/discover/watched/:userId', async (req, res, next) => {
  try {
    const sets = await loadCombinedWatchedIdSets(Number(req.params.userId));
    res.status(200).json({ movie: [...sets.movie], tv: [...sets.tv] });
  } catch (e) {
    next(e);
  }
});

// The release calendar sync's per-server statuses (process state), as
// `releaseCalendarSync.getSourceStatuses()` returns them; dates serialize
// as ISO strings. The Rust `/calendar` route derives `partialSources`
// from this list exactly as server/routes/calendar.ts does.
internalRoutes.get('/calendar/source-statuses', (_req, res) => {
  res.status(200).json(releaseCalendarSync.getSourceStatuses());
});

// The `refreshTokens` callback of a Rust-side user TraktAPI client:
// refreshUserTraktTokens(userId, callerTokens) under Node's per-user lock, with
// its database write and credential clearing. Always 200; a failure comes back
// as { error: { name, message } } so Rust can classify it like the route
// handler would (TraktReconnectRequiredError -> 401, anything else -> 500).
internalRoutes.post('/trakt/refresh', async (req, res) => {
  try {
    const { userId, tokens } = req.body ?? {};
    res
      .status(200)
      .json({ tokens: await refreshUserTraktTokens(Number(userId), tokens) });
  } catch (e) {
    res.status(200).json({
      error: {
        name: e instanceof Error ? e.name : 'Error',
        message: e instanceof Error ? e.message : 'unknown error',
      },
    });
  }
});

// ---- Simkl discover rows (sub-providers) ----

// syncSimklUser(userId) for GET /discover/simkl/library: the per-user lock
// and the 15-minute throttle live here.
internalRoutes.post('/simkl/sync', async (req, res, next) => {
  try {
    res
      .status(200)
      .json(
        await syncSimklUser(Number(req.body?.userId), Boolean(req.body?.force))
      );
  } catch (e) {
    next(e);
  }
});

// recordSimklGaps from routes/discover/simkl.ts (not exported there).
function recordSimklGapsInternal(
  resolved: ResolvedSimklItem[],
  discoverSource: string
): void {
  for (const { item, resolution, candidate } of resolved) {
    if (hasDiscoverTmdbId(item.tmdbId) || !item.sourceId) continue;
    recordMiss({
      ref: { ns: 'simkl', id: item.sourceId },
      title: item.title,
      mediaType: item.mediaType,
      discoverSource,
      ...(resolution.ambiguous && candidate.ids.tmdb
        ? { detail: `Simkl suggests TMDB ${candidate.ids.tmdb}, unconfirmed` }
        : {}),
    });
  }
}

// One page of hydrated candidates (at most 20): resolveSimklCandidates with
// the caller's TMDB client (createTmdbWithRegionLanguage(user), or without a
// user for trending), recordSimklGaps, then toSimklWatchlistItems (mapping
// state, hideUnmapped, posters, active-request annotation).
internalRoutes.post('/simkl/resolve', async (req, res, next) => {
  try {
    const { candidates, discoverSource, hideUnmapped, userId } = req.body ?? {};
    const user =
      userId != null
        ? ((await getRepository(User).findOne({
            where: { id: Number(userId) },
          })) ?? undefined)
        : undefined;
    const tmdb = createTmdbWithRegionLanguage(user);
    const resolved = await resolveSimklCandidates(
      (candidates ?? []) as SimklCandidate[],
      tmdbResolvers(tmdb)
    );
    recordSimklGapsInternal(resolved, String(discoverSource));
    res
      .status(200)
      .json(await toSimklWatchlistItems(resolved, Boolean(hideUnmapped), tmdb));
  } catch (e) {
    next(e);
  }
});

export default internalRoutes;
