import type { SimklActivities } from '@server/api/simkl/interfaces';
import dataSource, { getRepository } from '@server/datasource';
import {
  SimklSyncItem,
  type SimklItemStatus,
  type SimklItemType,
} from '@server/entity/SimklSyncItem';
import { SimklSyncState } from '@server/entity/SimklSyncState';
import { createSimklUserClient } from '@server/lib/simkl';
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
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};
const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;
const numberValue = (value: unknown): number | undefined => {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

function itemArrays(response: Record<string, unknown>): RawItem[] {
  const output: RawItem[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value)
        if (entry && typeof entry === 'object') output.push(entry as RawItem);
    } else if (value && typeof value === 'object') {
      for (const nested of Object.values(value)) visit(nested);
    }
  };
  visit(response);
  return output;
}

function normalizeItem(
  raw: RawItem,
  fallbackType?: SimklItemType
): Omit<SimklSyncItem, 'id' | 'user'> | null {
  const ids = (raw.ids && typeof raw.ids === 'object' ? raw.ids : {}) as Record<
    string,
    unknown
  >;
  const simklId = stringValue(ids.simkl ?? raw.simkl_id ?? raw.id);
  const simklType = (
    stringValue(raw.type ?? raw.simkl_type) === 'show'
      ? 'show'
      : stringValue(raw.type ?? raw.simkl_type) === 'anime'
        ? 'anime'
        : fallbackType
  ) as SimklItemType | undefined;
  const title = stringValue(raw.title ?? raw.name);
  const status = stringValue(raw.status) as SimklItemStatus | undefined;
  if (!simklId || !simklType || !title || !status || !STATUSES.has(status))
    return null;
  return {
    simklId,
    simklType,
    tmdbId: numberValue(ids.tmdb ?? raw.tmdb),
    tvdbId: numberValue(ids.tvdb ?? raw.tvdb),
    slug: stringValue(raw.slug),
    title,
    year: numberValue(raw.year),
    posterPath: stringValue(raw.poster ?? raw.poster_path),
    animeType: stringValue(raw.anime_type),
    status,
    userRating: numberValue(raw.user_rating ?? raw.rating),
    addedAt: toDate(raw.added_to_list_at ?? raw.added_at),
    lastWatchedAt: toDate(raw.last_watched_at ?? raw.last_watched),
    watchedEpisodeCount: numberValue(raw.watched_episodes_count),
    totalEpisodeCount: numberValue(raw.total_episodes_count),
  };
}

const watermark = (activities: SimklActivities): string | undefined =>
  stringValue(activities.all);
const removalWatermark = (activities: SimklActivities): string | undefined => {
  const values: string[] = [];
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>
    )) {
      if (key === 'removed_from_list' && typeof child === 'string')
        values.push(child);
      else walk(child);
    }
  };
  walk(activities);
  return values.sort().at(-1);
};

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
      const activities = await client.getActivities();
      const nextWatermark = watermark(activities);
      if (!nextWatermark)
        throw new Error('Simkl activities response did not contain all');
      const oldActivities = previous?.activities
        ? (JSON.parse(previous.activities) as SimklActivities)
        : undefined;
      if (
        previous?.initialSyncComplete &&
        watermark(oldActivities ?? {}) === nextWatermark
      ) {
        previous.lastCheckedAt = new Date();
        previous.lastError = undefined;
        await stateRepository.save(previous);
        return {
          performed: true,
          stale: false,
          lastSuccessfulSyncAt: previous.lastSuccessfulSyncAt?.toISOString(),
        };
      }
      const batches: {
        type?: SimklItemType;
        data: Record<string, unknown>;
      }[] = [];
      if (!previous?.initialSyncComplete) {
        for (const type of TYPES)
          batches.push({
            type: type.local,
            data: await client.getAllItems(type.upstream),
          });
      } else {
        batches.push({
          data: await client.getAllItems(undefined, {
            date_from: watermark(oldActivities ?? {})!,
          }),
        });
      }
      const items = batches.flatMap(({ type, data }) =>
        itemArrays(data)
          .map((item) => normalizeItem(item, type))
          .filter((item): item is Omit<SimklSyncItem, 'id' | 'user'> =>
            Boolean(item)
          )
      );
      const mustReconcile =
        removalWatermark(activities) !== removalWatermark(oldActivities ?? {});
      let upstreamIds: Set<string> | undefined;
      if (mustReconcile) {
        upstreamIds = new Set();
        for (const type of TYPES) {
          for (const raw of itemArrays(
            await client.getAllItems(type.upstream, {
              extended: 'simkl_ids_only',
            })
          )) {
            const ids = (
              raw.ids && typeof raw.ids === 'object' ? raw.ids : {}
            ) as Record<string, unknown>;
            const id = stringValue(ids.simkl ?? raw.simkl_id ?? raw.id);
            if (id) upstreamIds.add(`${type.local}:${id}`);
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
        state.activities = JSON.stringify(activities);
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
