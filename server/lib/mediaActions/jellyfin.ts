import { MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  createUserJellyfinClient,
  findLinkedJellyfinUser,
} from '@server/lib/library';
import { getSettings } from '@server/lib/settings';
import { In } from 'typeorm';
import {
  getCachedJellyfinWatched,
  invalidateJellyfinStatusCache,
  setCachedJellyfinWatched,
} from './jellyfinStatusCache';
import {
  JELLYFIN_MEDIA_ACTION_CAPABILITIES,
  type MarkWatchedOptions,
  type MediaActionProvider,
  type MediaActionStatus,
  type MediaItemRef,
  type RateOptions,
  type UnmarkWatchedOptions,
} from './types';

function emptyStatus(): MediaActionStatus {
  return { watched: false, rating: null, ratingStars: null };
}

export const JELLYFIN_STATUS_BATCH_CHUNK_SIZE = 50;

/** Fetch bounded chunks without allowing one failure to erase other results. */
export async function fetchJellyfinStatusChunks<T>(
  ids: string[],
  fetch: (chunk: string[]) => Promise<T[]>
): Promise<{ entries: T[]; failedIds: string[] }> {
  const uniqueIds = [...new Set(ids)];
  const entries: T[] = [];
  const failedIds: string[] = [];

  for (
    let index = 0;
    index < uniqueIds.length;
    index += JELLYFIN_STATUS_BATCH_CHUNK_SIZE
  ) {
    const chunk = uniqueIds.slice(
      index,
      index + JELLYFIN_STATUS_BATCH_CHUNK_SIZE
    );
    try {
      entries.push(...(await fetch(chunk)));
    } catch {
      failedIds.push(...chunk);
    }
  }
  return { entries, failedIds };
}

export const jellyfinEpisodeActions = {
  async isAvailable(userId: number): Promise<boolean> {
    return Boolean(await getJellyfinEpisodeClient(userId));
  },

  async setEpisodeWatched(
    userId: number,
    tmdbShowId: number,
    seasonNumber: number,
    episodeNumber: number,
    watched: boolean
  ): Promise<boolean> {
    const client = await getJellyfinEpisodeClient(userId);
    if (!client) return false;

    const mediaRepository = getRepository(Media);
    const media = await mediaRepository.findOne({
      where: { tmdbId: tmdbShowId, mediaType: MediaType.TV },
    });
    const seriesId = media?.jellyfinMediaId ?? media?.jellyfinMediaId4k;
    if (!seriesId) return false;

    try {
      const seasons = await client.getSeasons(seriesId);
      const season = seasons.find((s) => s.IndexNumber === seasonNumber);
      if (!season) return false;

      const episodes = await client.getEpisodes(seriesId, season.Id, {
        includeMediaInfo: true,
      });
      const episode = episodes.find((e) => e.IndexNumber === episodeNumber);
      if (!episode) return false;

      if (watched) {
        await client.markPlayed(episode.Id);
      } else {
        await client.markUnplayed(episode.Id);
      }
      invalidateJellyfinStatusCache(userId);
      setCachedJellyfinWatched(userId, episode.Id, watched);
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Library pages already know Jellyfin's opaque episode ID. The server uses
   * the linked-user client, so neither a token nor any other credential is
   * accepted or returned by this API.
   */
  async setItemWatched(
    userId: number,
    jellyfinItemId: string,
    watched: boolean
  ): Promise<boolean> {
    const client = await getJellyfinEpisodeClient(userId);
    if (!client) return false;

    try {
      const item = await client.getItemData(jellyfinItemId);
      if (!item || item.Type !== 'Episode') return false;
      if (watched) {
        await client.markPlayed(jellyfinItemId);
      } else {
        await client.markUnplayed(jellyfinItemId);
      }
      invalidateJellyfinStatusCache(userId);
      setCachedJellyfinWatched(userId, jellyfinItemId, watched);
      return true;
    } catch {
      return false;
    }
  },

  async getSeasonStatus(
    userId: number,
    tmdbShowId: number,
    seasonNumber: number
  ): Promise<{ available: boolean; watchedEpisodeNumbers: number[] }> {
    const client = await getJellyfinEpisodeClient(userId);
    if (!client) return { available: false, watchedEpisodeNumbers: [] };

    const mediaRepository = getRepository(Media);
    const media = await mediaRepository.findOne({
      where: { tmdbId: tmdbShowId, mediaType: MediaType.TV },
    });
    const seriesId = media?.jellyfinMediaId ?? media?.jellyfinMediaId4k;
    if (!seriesId) return { available: false, watchedEpisodeNumbers: [] };

    try {
      const seasons = await client.getSeasons(seriesId);
      const season = seasons.find((s) => s.IndexNumber === seasonNumber);
      if (!season) return { available: true, watchedEpisodeNumbers: [] };

      const episodes = await client.getEpisodes(seriesId, season.Id, {
        includeMediaInfo: true,
      });
      const watchedEpisodes = episodes
        .filter((e) => e.UserData?.Played)
        .map((e) => e.IndexNumber)
        .filter((n): n is number => n != null)
        .sort((a, b) => a - b);

      return { available: true, watchedEpisodeNumbers: watchedEpisodes };
    } catch {
      return { available: false, watchedEpisodeNumbers: [] };
    }
  },
};

async function getJellyfinEpisodeClient(userId: number) {
  const settings = getSettings();
  if (settings.mediaActions?.providers?.jellyfin === false) return null;
  if (settings.main.mediaServerType !== MediaServerType.JELLYFIN) return null;

  const result = await createUserJellyfinClient(userId);
  if (!result.ok) return null;
  return result.client;
}

export class JellyfinMediaActionProvider implements MediaActionProvider {
  readonly id = 'jellyfin' as const;
  readonly capabilities = JELLYFIN_MEDIA_ACTION_CAPABILITIES;

  async isAvailable(userId: number): Promise<boolean> {
    const settings = getSettings();
    if (settings.mediaActions?.providers?.jellyfin === false) {
      return false;
    }
    if (settings.main.mediaServerType !== MediaServerType.JELLYFIN) {
      return false;
    }
    const user = await findLinkedJellyfinUser(userId);
    if (
      !user?.jellyfinUserId ||
      !user.jellyfinAuthToken ||
      !user.jellyfinDeviceId
    ) {
      return false;
    }
    return true;
  }

  async getStatus(
    userId: number,
    item: MediaItemRef
  ): Promise<MediaActionStatus> {
    const media = await this.findMediaItem(item);
    const jellyfinId = media?.jellyfinMediaId ?? media?.jellyfinMediaId4k;
    if (!jellyfinId) {
      throw new Error('No Jellyfin mapping for item');
    }

    const { client } = await this.getClient(userId);
    try {
      const data = await client.getItemData(jellyfinId);
      return {
        watched: data?.UserData?.Played ?? false,
        rating: null,
        ratingStars: null,
      };
    } catch (error) {
      throw error instanceof Error
        ? error
        : new Error('Failed to read Jellyfin watch state');
    }
  }

  async getStatuses(
    userId: number,
    items: MediaItemRef[]
  ): Promise<(MediaItemRef & MediaActionStatus)[]> {
    if (items.length === 0) return [];

    const { client } = await this.getClient(userId);
    const mediaByKey = await this.findMediaItems(items);
    const results: (MediaItemRef & MediaActionStatus)[] = [];
    const idsToFetch: string[] = [];
    const itemsByJellyfinId = new Map<string, MediaItemRef[]>();

    for (const item of items) {
      const media = mediaByKey.get(`${item.mediaType}:${item.tmdbId}`);
      const jellyfinId = media?.jellyfinMediaId ?? media?.jellyfinMediaId4k;
      if (!jellyfinId) {
        results.push({
          ...item,
          ...emptyStatus(),
          error: 'No Jellyfin mapping for item',
        });
        continue;
      }
      const cached = getCachedJellyfinWatched(userId, jellyfinId);
      if (cached != null) {
        results.push({
          ...item,
          watched: cached,
          rating: null,
          ratingStars: null,
        });
        continue;
      }
      const mappedItems = itemsByJellyfinId.get(jellyfinId);
      if (mappedItems) {
        mappedItems.push(item);
      } else {
        idsToFetch.push(jellyfinId);
        itemsByJellyfinId.set(jellyfinId, [item]);
      }
    }

    const { entries, failedIds } = await fetchJellyfinStatusChunks(
      idsToFetch,
      (chunk) => client.getItemsData(chunk)
    );
    const byId = new Map(entries.map((entry) => [entry.Id, entry]));
    for (const jellyfinId of idsToFetch) {
      const mappedItems = itemsByJellyfinId.get(jellyfinId) ?? [];
      const entry = byId.get(jellyfinId);
      if (!entry) {
        const error = failedIds.includes(jellyfinId)
          ? 'Failed to read Jellyfin watch state'
          : 'Jellyfin did not return item status';
        for (const item of mappedItems) {
          results.push({ ...item, ...emptyStatus(), error });
        }
        continue;
      }

      const watched = entry.UserData?.Played ?? false;
      setCachedJellyfinWatched(userId, jellyfinId, watched);
      for (const item of mappedItems) {
        results.push({
          ...item,
          watched,
          rating: null,
          ratingStars: null,
        });
      }
    }

    return results;
  }

  async markWatched(
    userId: number,
    item: MediaItemRef,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: MarkWatchedOptions = {}
  ): Promise<MediaActionStatus> {
    const media = await this.findMediaItem(item);
    const jellyfinId = media?.jellyfinMediaId ?? media?.jellyfinMediaId4k;
    if (!jellyfinId) {
      throw new Error('No Jellyfin mapping for item');
    }

    const { client } = await this.getClient(userId);
    await client.markPlayed(jellyfinId);
    invalidateJellyfinStatusCache(userId);
    setCachedJellyfinWatched(userId, jellyfinId, true);
    return { watched: true, rating: null, ratingStars: null };
  }

  async unmarkWatched(
    userId: number,
    item: MediaItemRef,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: UnmarkWatchedOptions = {}
  ): Promise<MediaActionStatus> {
    const media = await this.findMediaItem(item);
    const jellyfinId = media?.jellyfinMediaId ?? media?.jellyfinMediaId4k;
    if (!jellyfinId) {
      throw new Error('No Jellyfin mapping for item');
    }

    const { client } = await this.getClient(userId);
    await client.markUnplayed(jellyfinId);
    invalidateJellyfinStatusCache(userId);
    setCachedJellyfinWatched(userId, jellyfinId, false);
    return { watched: false, rating: null, ratingStars: null };
  }

  async rate(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _userId: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _item: MediaItemRef,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: RateOptions
  ): Promise<MediaActionStatus> {
    throw new Error('Jellyfin does not support rating writes');
  }

  private async getClient(userId: number) {
    const result = await createUserJellyfinClient(userId);
    if (!result.ok) {
      throw new Error('Jellyfin client not available');
    }
    return result;
  }

  private async findMediaItems(
    items: MediaItemRef[]
  ): Promise<Map<string, Media>> {
    const mediaRepository = getRepository(Media);
    const movieIds = items
      .filter((item) => item.mediaType === 'movie')
      .map((item) => item.tmdbId);
    const tvIds = items
      .filter((item) => item.mediaType === 'tv')
      .map((item) => item.tmdbId);

    const [movies, shows] = await Promise.all([
      movieIds.length
        ? mediaRepository.find({
            where: { mediaType: MediaType.MOVIE, tmdbId: In(movieIds) },
          })
        : Promise.resolve([]),
      tvIds.length
        ? mediaRepository.find({
            where: { mediaType: MediaType.TV, tmdbId: In(tvIds) },
          })
        : Promise.resolve([]),
    ]);

    const map = new Map<string, Media>();
    for (const media of [...movies, ...shows]) {
      const mediaType = media.mediaType === MediaType.MOVIE ? 'movie' : 'tv';
      map.set(`${mediaType}:${media.tmdbId}`, media);
    }
    return map;
  }

  private async findMediaItem(
    item: MediaItemRef
  ): Promise<Media | undefined | null> {
    const mediaRepository = getRepository(Media);
    const mediaType =
      item.mediaType === 'movie' ? MediaType.MOVIE : MediaType.TV;
    return mediaRepository.findOne({
      where: { tmdbId: item.tmdbId, mediaType },
    });
  }
}
