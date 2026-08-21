import type AnilistAPI from '@server/api/anilist';
import type {
  AnilistDiscoverItem,
  AnilistListSummary,
  AnilistMedia,
  AnilistMediaListStatus,
} from '@server/api/anilist/interfaces';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import anilistIdMapping, {
  anilistFormatToMediaType,
} from '@server/lib/anilist/mapping';
import {
  anilistSourceUrl,
  hasDiscoverTmdbId,
} from '@server/lib/discover/unmapped';

const STATUS_LIST_NAMES: Record<AnilistMediaListStatus, string> = {
  CURRENT: 'Watching',
  PLANNING: 'Planning',
  COMPLETED: 'Completed',
  DROPPED: 'Dropped',
  PAUSED: 'Paused',
  REPEATING: 'Repeating',
};

export function anilistMediaTitle(media?: AnilistMedia | null): string {
  return (
    media?.title?.english?.trim() ||
    media?.title?.romaji?.trim() ||
    media?.title?.native?.trim() ||
    ''
  );
}

function anilistCoverImage(media: AnilistMedia): string | undefined {
  return (
    media.coverImage?.large?.trim() ||
    media.coverImage?.medium?.trim() ||
    undefined
  );
}

export async function mapAnilistMedia(
  media: AnilistMedia
): Promise<AnilistDiscoverItem | null> {
  if (!media?.id || media.format === 'MUSIC') {
    return null;
  }
  await anilistIdMapping.sync();
  const mapped = anilistIdMapping.getFromAnilistId(media.id);
  const title = anilistMediaTitle(media) || `AniList ${media.id}`;
  const image = anilistCoverImage(media);
  if (!mapped) {
    return {
      anilistId: media.id,
      mediaType: anilistFormatToMediaType(media.format),
      title,
      ...(image ? { image } : {}),
    };
  }
  return {
    anilistId: media.id,
    tmdbId: mapped.tmdbId,
    mediaType: mapped.mediaType ?? anilistFormatToMediaType(media.format),
    title,
    ...(image ? { image } : {}),
  };
}

export async function mapAnilistMediaList(
  mediaList: AnilistMedia[]
): Promise<AnilistDiscoverItem[]> {
  const mapped: AnilistDiscoverItem[] = [];
  const seen = new Set<string>();
  for (const media of mediaList) {
    const item = await mapAnilistMedia(media);
    if (!item) {
      continue;
    }
    const anilistKey = `anilist:${item.anilistId}`;
    if (seen.has(anilistKey)) {
      continue;
    }
    seen.add(anilistKey);
    if (hasDiscoverTmdbId(item.tmdbId)) {
      const tmdbKey = `${item.mediaType}:${item.tmdbId}`;
      if (seen.has(tmdbKey)) {
        continue;
      }
      seen.add(tmdbKey);
    }
    mapped.push(item);
  }
  return mapped;
}

export function toWatchlistItems(
  items: AnilistDiscoverItem[]
): WatchlistItem[] {
  return items.map((item) => ({
    id: hasDiscoverTmdbId(item.tmdbId) ? item.tmdbId : item.anilistId,
    ratingKey: `anilist-${item.anilistId}`,
    ...(hasDiscoverTmdbId(item.tmdbId) ? { tmdbId: item.tmdbId } : {}),
    mediaType: item.mediaType,
    title: item.title,
    source: 'anilist' as const,
    sourceId: String(item.anilistId),
    sourceUrl: anilistSourceUrl(item.anilistId),
    ...(item.image ? { image: item.image } : {}),
  }));
}

export function paginateItems<T>(
  items: T[],
  page: number,
  itemsPerPage = 20
): { results: T[]; hasMore: boolean; page: number } {
  const safePage = Number.isFinite(page) && page > 0 ? page : 1;
  const start = (safePage - 1) * itemsPerPage;
  return {
    page: safePage,
    results: items.slice(start, start + itemsPerPage),
    hasMore: start + itemsPerPage < items.length,
  };
}

export async function collectUserListItems(
  client: AnilistAPI,
  anilistUserId: number,
  matcher: (list: {
    name: string;
    status: AnilistMediaListStatus | null;
    isCustomList: boolean;
  }) => boolean
): Promise<AnilistDiscoverItem[]> {
  const collection = await client.getMediaListCollection(anilistUserId);
  const media: AnilistMedia[] = [];
  const seenMedia = new Set<number>();

  for (const list of collection.lists) {
    const summary = {
      name: list.name,
      status: list.status ?? null,
      isCustomList: Boolean(list.isCustomList),
    };
    if (!matcher(summary)) {
      continue;
    }
    for (const entry of list.entries ?? []) {
      const id = entry.media?.id;
      if (!id || seenMedia.has(id) || !entry.media) {
        continue;
      }
      seenMedia.add(id);
      media.push(entry.media);
    }
  }

  return mapAnilistMediaList(media);
}

export async function listUserAniListLists(
  client: AnilistAPI,
  anilistUserId: number
): Promise<AnilistListSummary[]> {
  const collection = await client.getMediaListCollection(anilistUserId);
  return collection.lists.map((list) => ({
    name: list.name,
    status: list.status ?? null,
    isCustomList: Boolean(list.isCustomList),
    itemCount: list.entries?.length ?? 0,
  }));
}

export function statusListName(status: AnilistMediaListStatus): string {
  return STATUS_LIST_NAMES[status];
}

export function matchesListName(
  list: { name: string; status: AnilistMediaListStatus | null },
  name: string
): boolean {
  const requested = name.trim().toLowerCase();
  if (!requested) {
    return false;
  }
  if (list.name.trim().toLowerCase() === requested) {
    return true;
  }
  if (list.status && statusListName(list.status).toLowerCase() === requested) {
    return true;
  }
  if (list.status?.toLowerCase() === requested) {
    return true;
  }
  return false;
}
