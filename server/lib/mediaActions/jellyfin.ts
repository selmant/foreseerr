import { MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  createUserJellyfinClient,
  findLinkedJellyfinUser,
} from '@server/lib/library';
import { getSettings } from '@server/lib/settings';
import type {
  MarkWatchedOptions,
  MediaActionProvider,
  MediaActionStatus,
  MediaItemRef,
  RateOptions,
  UnmarkWatchedOptions,
} from './types';

function emptyStatus(): MediaActionStatus {
  return { watched: false, rating: null, ratingStars: null };
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
      return emptyStatus();
    }

    const { client } = await this.getClient(userId);
    try {
      const data = await client.getItemData(jellyfinId);
      return {
        watched: data?.UserData?.Played ?? false,
        rating: null,
        ratingStars: null,
      };
    } catch {
      return emptyStatus();
    }
  }

  async getStatuses(
    userId: number,
    items: MediaItemRef[]
  ): Promise<(MediaItemRef & MediaActionStatus)[]> {
    if (items.length === 0) return [];

    const { client } = await this.getClient(userId);
    const results: (MediaItemRef & MediaActionStatus)[] = [];

    for (const item of items) {
      const media = await this.findMediaItem(item);
      const jellyfinId = media?.jellyfinMediaId ?? media?.jellyfinMediaId4k;
      if (!jellyfinId) {
        results.push({ ...item, ...emptyStatus() });
        continue;
      }
      try {
        const data = await client.getItemData(jellyfinId);
        results.push({
          ...item,
          watched: data?.UserData?.Played ?? false,
          rating: null,
          ratingStars: null,
        });
      } catch {
        results.push({ ...item, ...emptyStatus() });
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
      return emptyStatus();
    }

    const { client } = await this.getClient(userId);
    await client.markPlayed(jellyfinId);
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
      return emptyStatus();
    }

    const { client } = await this.getClient(userId);
    await client.markUnplayed(jellyfinId);
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
    return emptyStatus();
  }

  private async getClient(userId: number) {
    const result = await createUserJellyfinClient(userId);
    if (!result.ok) {
      throw new Error('Jellyfin client not available');
    }
    return result;
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
