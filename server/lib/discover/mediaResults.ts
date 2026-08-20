import type { MediaType } from '@server/constants/media';
import Media from '@server/entity/Media';
import type { User } from '@server/entity/User';

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
  return indexRelatedMedia(await Media.getRelatedMedia(user, items));
}

export function findRelatedMedia(
  media: Map<string, Media>,
  tmdbId: number,
  mediaType: MediaType
): Media | undefined {
  return media.get(relatedMediaKey(tmdbId, mediaType));
}

function relatedMediaKey(tmdbId: number, mediaType: MediaType): string {
  return `${mediaType}:${tmdbId}`;
}
