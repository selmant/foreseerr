import type { MediaType } from '@server/constants/media';
import Media from '@server/entity/Media';
import type { User } from '@server/entity/User';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import { getSettings } from '@server/lib/settings';

type RelatedMediaItem = {
  tmdbId: number;
  mediaType: MediaType;
};

/**
 * Build the lookup used while mapping a Discover page.
 *
 * Discover routes used to search the complete related-media array for every
 * upstream result. Besides duplicating the same mapping code in each route,
 * that made a page with n results do n linear scans. Keeping the media type in
 * the key is important: TMDB IDs are only unique within a media type.
 */
export function indexRelatedMedia(media: Media[]): Map<string, Media> {
  return new Map(
    media.map((item) => [relatedMediaKey(item.tmdbId, item.mediaType), item])
  );
}

export async function getRelatedMediaIndex(
  user: User | undefined,
  items: RelatedMediaItem[]
): Promise<Map<string, Media>> {
  return indexRelatedMedia(
    await Media.getRelatedMedia(user, items, { includeActiveRequest: true })
  );
}

export function findRelatedMedia(
  media: Map<string, Media>,
  tmdbId: number,
  mediaType: MediaType
): Media | undefined {
  return media.get(relatedMediaKey(tmdbId, mediaType));
}

/** Mark mapped provider tiles for the shared Discover and slider filters. */
export async function annotateProviderActiveRequests<T extends WatchlistItem>(
  items: T[]
): Promise<T[]> {
  if (!getSettings().main.hideRequested) return items;
  const related = await getRelatedMediaIndex(
    undefined,
    items.flatMap((item) =>
      typeof item.tmdbId === 'number' &&
      item.tmdbId > 0 &&
      (item.mediaType === 'movie' || item.mediaType === 'tv')
        ? [{ tmdbId: item.tmdbId, mediaType: item.mediaType as MediaType }]
        : []
    )
  );
  return items.map((item) => {
    if (!item.tmdbId || !item.mediaType) return item;
    const active = findRelatedMedia(
      related,
      item.tmdbId,
      item.mediaType as MediaType
    )?.hasActiveRequest;
    return active ? { ...item, hasActiveRequest: true } : item;
  });
}

function relatedMediaKey(tmdbId: number, mediaType: MediaType): string {
  return `${mediaType}:${tmdbId}`;
}
