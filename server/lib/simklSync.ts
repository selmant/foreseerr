import type { SimklActivities } from '@server/api/simkl/interfaces';
import dataSource, { getRepository } from '@server/datasource';
import {
  SimklSyncItem,
  type SimklItemStatus,
  type SimklItemType,
} from '@server/entity/SimklSyncItem';
import { SimklSyncState } from '@server/entity/SimklSyncState';
import { SimklRequestError } from '@server/api/simkl';
import { createSimklUserClient } from '@server/lib/simkl';
import {
  simklPosterUrl,
  simklRecordId,
  syncEntries,
} from '@server/lib/simklCatalog';
import AsyncLock from '@server/utils/asyncLock';

const syncLock = new AsyncLock();
const AUTO_SYNC_MIN_INTERVAL_MS = 15 * 60 * 1000;
const TYPES: {
  upstream: 'shows' | 'movies' | 'anime';
  local: SimklItemType;
}[] = [
  { upstream: 'shows', local: 'show' },
  { upstream: 'movies', local: 'movie' },
  { upstream: 'anime', local: 'anime' },
];
const STATUSES = new Set<SimklItemStatus>([
  'watching',
  'plantowatch',
  'hold',
  'completed',
  'dropped',
]);

export interface SimklSyncResult {
  performed: boolean;
  stale: boolean;
  lastSuccessfulSyncAt?: string;
  error?: string;
}

type RawItem = Record<string, unknown>;

const toDate = (value: unknown): Date | undefined => {
  const timestamp =
    typeof value === 'number' && Number.isFinite(value)
      ? // Simkl timestamps are Unix seconds; JavaScript dates use milliseconds.
        value * 1000
      : value;
  if (typeof timestamp !== 'string' && typeof timestamp !== 'number')
    return undefined;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date;
};
const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;
const scalarValue = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
};
const numberValue = (value: unknown): number | undefined => {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

/** Watched episodes from an `extended=full` row, in Simkl's numbering. */
export const episodeCoordinates = (raw: RawItem): [number, number][] => {
  const seasons = Array.isArray(raw.seasons) ? raw.seasons : [];
  return seasons.flatMap((season: unknown) => {
    if (!season || typeof season !== 'object') return [];
    const { number, episodes } = season as {
      number?: unknown;
      episodes?: unknown;
    };
    const seasonNumber = Number(number);
    if (!Number.isInteger(seasonNumber) || seasonNumber < 0) return [];
    return (Array.isArray(episodes) ? episodes : []).flatMap(
      (episode: unknown) => {
        const episodeNumber = Number(
          (episode as { number?: unknown } | null)?.number
        );
        return Number.isInteger(episodeNumber) && episodeNumber > 0
          ? [[seasonNumber, episodeNumber] as [number, number]]
          : [];
      }
    );
  });
};

/**
 * `withEpisodes`: the row came from an `extended=full` request, so a show
 * without `seasons` has no watched episodes. Other rows leave them alone.
 */
function normalizeItem(
  raw: RawItem,
  fallbackType?: SimklItemType,
  withEpisodes = false
): Omit<SimklSyncItem, 'id' | 'user'> | null {
  const ids = (raw.ids && typeof raw.ids === 'object' ? raw.ids : {}) as Record<
    string,
    unknown
  >;
  const simklId = simklRecordId(raw, ids);
  const simklType = (
    stringValue(raw.type ?? raw.simkl_type) === 'show'
      ? 'show'
      : stringValue(raw.type ?? raw.simkl_type) === 'anime'
        ? 'anime'
        : stringValue(raw.type ?? raw.simkl_type) === 'movie'
          ? 'movie'
          : fallbackType
  ) as SimklItemType | undefined;
  const title = stringValue(raw.title ?? raw.name);
  const status = stringValue(raw.status) as SimklItemStatus | undefined;
  if (!simklId || !simklType || !title || !status || !STATUSES.has(status))
    return null;
  const idsRecord = ids as Record<string, unknown>;
  return {
    simklId,
    simklType,
    tmdbId: numberValue(idsRecord.tmdb ?? raw.tmdb),
    tvdbId: numberValue(idsRecord.tvdb ?? raw.tvdb),
    slug: stringValue(raw.slug ?? idsRecord.slug),
    title,
    year: numberValue(raw.year),
    posterPath: simklPosterUrl(
      stringValue(raw.poster ?? raw.poster_path) ?? null
    ),
    animeType: stringValue(raw.anime_type),
    status,
    // `null` clears a removed rating; a missing one leaves the cache alone.
    userRating:
      raw.user_rating === null
        ? null
        : numberValue(raw.user_rating ?? raw.rating),
    addedAt: toDate(
      raw.added_to_list_at ?? raw.added_to_watchlist_at ?? raw.added_at
    ),
    lastWatchedAt: toDate(raw.last_watched_at ?? raw.last_watched),
    watchedEpisodeCount: numberValue(raw.watched_episodes_count),
    totalEpisodeCount: numberValue(raw.total_episodes_count),
    ...(withEpisodes && simklType !== 'movie'
      ? { watchedEpisodes: JSON.stringify(episodeCoordinates(raw)) }
      : {}),
  };
}

const watermark = (activities: SimklActivities): string | undefined =>
  scalarValue(activities.all);

/** Activity buckets per media type; `custom_lists` and `settings` are unused. */
const MEDIA_ACTIVITIES = ['tv_shows', 'anime', 'movies'] as const;

/**
 * Which parts of the library moved between two `/sync/activities` snapshots.
 * Every other key of a media bucket is a list status (`watching`,
 * `plantowatch`, …); `all` only summarizes them, and `playback` is unused.
 */
export const movedActivities = (
  now: SimklActivities,
  before: SimklActivities
): { statuses: boolean; removals: boolean; ratings: boolean } => {
  const moved = { statuses: false, removals: false, ratings: false };
  for (const media of MEDIA_ACTIVITIES) {
    const current = (now[media] ?? {}) as Record<string, unknown>;
    const previous = (before[media] ?? {}) as Record<string, unknown>;
    for (const key of new Set([
      ...Object.keys(current),
      ...Object.keys(previous),
    ])) {
      if (scalarValue(current[key]) === scalarValue(previous[key])) continue;
      if (key === 'removed_from_list') moved.removals = true;
      else if (key === 'rated_at') moved.ratings = true;
      else if (key !== 'all' && key !== 'playback') moved.statuses = true;
    }
  }
  return moved;
};

/** Shows and anime carry their watched episodes; movies have none. */
const EPISODE_PARAMS = { extended: 'full', include_all_episodes: 'yes' };

const isMaxItemsError = (error: unknown): boolean =>
  error instanceof SimklRequestError &&
  error.status === 400 &&
  /max_items|too many/i.test(error.message);

export async function syncSimklUser(
  userId: number,
  force = false
): Promise<SimklSyncResult> {
  return syncLock.dispatch(userId, async () => {
    const stateRepository = getRepository(SimklSyncState);
    const previous = await stateRepository.findOne({
      where: { user: { id: userId } },
    });
    if (
      !force &&
      previous?.lastCheckedAt &&
      Date.now() - previous.lastCheckedAt.getTime() < AUTO_SYNC_MIN_INTERVAL_MS
    ) {
      return {
        performed: false,
        stale: false,
        lastSuccessfulSyncAt: previous.lastSuccessfulSyncAt?.toISOString(),
      };
    }
    try {
      const client = await createSimklUserClient(userId);
      // Read before pulling, so a change made meanwhile is in the next delta.
      const activities = await client.getActivities();
      const activitiesSnapshot = JSON.stringify(activities);
      const oldActivities = previous?.activities
        ? (JSON.parse(previous.activities) as SimklActivities)
        : undefined;
      const oldWatermark = oldActivities ? watermark(oldActivities) : undefined;
      const fullPull =
        !previous?.initialSyncComplete || !oldActivities || !oldWatermark;
      if (!fullPull && watermark(activities) === oldWatermark) {
        previous.lastCheckedAt = new Date();
        previous.lastError = undefined;
        await stateRepository.save(previous);
        return {
          performed: true,
          stale: false,
          lastSuccessfulSyncAt: previous.lastSuccessfulSyncAt?.toISOString(),
        };
      }

      const items: Omit<SimklSyncItem, 'id' | 'user'>[] = [];
      const collect = (
        data: unknown,
        type?: SimklItemType,
        withEpisodes = false
      ) => {
        for (const { item, type: entryType } of syncEntries(data, type)) {
          const normalized = normalizeItem(item, entryType, withEpisodes);
          if (normalized) items.push(normalized);
        }
      };
      // Everything still on Simkl; local items missing from it were removed.
      let upstreamIds: Set<string> | undefined;

      const moved =
        fullPull || !oldWatermark
          ? undefined
          : {
              since: oldWatermark,
              ...movedActivities(activities, oldActivities),
            };
      let delta: { data: unknown } | undefined;
      let pullAll = fullPull;
      if (moved?.statuses) {
        try {
          delta = {
            data: await client.getAllItems(undefined, {
              date_from: moved.since,
              ...EPISODE_PARAMS,
            }),
          };
        } catch (error) {
          if (!isMaxItemsError(error)) throw error;
          // Too much changed for one call: pull everything again, split as
          // the initial import is.
          pullAll = true;
        }
      }

      if (pullAll || !moved) {
        // One type after another, never in parallel.
        for (const type of TYPES) {
          const params = type.local === 'movie' ? {} : EPISODE_PARAMS;
          let batches: unknown[];
          try {
            batches = [await client.getAllItems(type.upstream, params)];
          } catch (error) {
            if (!isMaxItemsError(error)) throw error;
            batches = [];
            for (const status of STATUSES)
              batches.push(
                await client.getAllItems(type.upstream, params, status)
              );
          }
          for (const data of batches)
            collect(data, type.local, type.local !== 'movie');
        }
        upstreamIds = new Set(
          items.map((item) => `${item.simklType}:${item.simklId}`)
        );
      } else {
        if (delta) collect(delta.data, undefined, true);
        // A rating change on a listed item moves only `rated_at`.
        if (moved.ratings) collect(await client.getRatings(moved.since));
        if (moved.removals) {
          upstreamIds = new Set();
          for (const { item, type } of syncEntries(
            await client.getAllItems(undefined, {
              extended: 'simkl_ids_only',
            })
          )) {
            const ids = (
              item.ids && typeof item.ids === 'object' ? item.ids : {}
            ) as Record<string, unknown>;
            const id = simklRecordId(item, ids);
            if (id) upstreamIds.add(`${type}:${id}`);
          }
        }
      }
      const now = new Date();
      await dataSource.transaction(async (manager) => {
        const itemRepository = manager.getRepository(SimklSyncItem);
        for (const item of items) {
          const existing = await itemRepository.findOne({
            where: {
              user: { id: userId },
              simklType: item.simklType,
              simklId: item.simklId,
            },
          });
          await itemRepository.save(
            itemRepository.create({
              ...existing,
              ...item,
              user: { id: userId },
            })
          );
        }
        if (upstreamIds) {
          const existing = await itemRepository.find({
            where: { user: { id: userId } },
          });
          await itemRepository.remove(
            existing.filter(
              (item) => !upstreamIds!.has(`${item.simklType}:${item.simklId}`)
            )
          );
        }
        const state =
          previous ??
          manager
            .getRepository(SimklSyncState)
            .create({ user: { id: userId }, initialSyncComplete: false });
        state.activities = activitiesSnapshot;
        state.initialSyncComplete = true;
        state.lastCheckedAt = now;
        state.lastSuccessfulSyncAt = now;
        state.lastError = undefined;
        await manager.getRepository(SimklSyncState).save(state);
      });
      return {
        performed: true,
        stale: false,
        lastSuccessfulSyncAt: now.toISOString(),
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Simkl synchronization failed';
      if (previous) {
        previous.lastCheckedAt = new Date();
        previous.lastError = message;
        await stateRepository.save(previous);
      }
      return {
        performed: true,
        stale: true,
        lastSuccessfulSyncAt: previous?.lastSuccessfulSyncAt?.toISOString(),
        error: message,
      };
    }
  });
}
