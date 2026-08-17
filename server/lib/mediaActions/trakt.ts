import { getSettings } from '@server/lib/settings';
import {
  TraktNotConfiguredError,
  createTraktUserClient,
  getTraktAppCredentials,
  traktAvailabilityFromError,
} from '@server/lib/trakt';
import { providerRatingToStars, ratingStarsToProvider } from './score';
import {
  getCachedItemStatus,
  lookupItemStatus,
  patchUserSyncItem,
  warmUserSyncCache,
} from './syncCache';
import {
  TRAKT_MEDIA_ACTION_CAPABILITIES,
  type MarkWatchedOptions,
  type MediaActionProvider,
  type MediaActionStatus,
  type MediaItemRef,
  type RateOptions,
  type UnmarkWatchedOptions,
} from './types';

function toStatus(watched: boolean, rating: number | null): MediaActionStatus {
  return {
    watched,
    rating,
    ratingStars: providerRatingToStars(rating),
  };
}

function watchedAtIso(
  watchedAt: 'now' | 'release' = 'now'
): string | undefined {
  if (watchedAt === 'release') {
    return undefined;
  }
  return new Date().toISOString();
}

export class TraktMediaActionProvider implements MediaActionProvider {
  readonly id = 'trakt' as const;
  readonly capabilities = TRAKT_MEDIA_ACTION_CAPABILITIES;

  async isAvailable(userId: number): Promise<boolean> {
    const settings = getSettings();
    if (settings.mediaActions?.providers?.trakt === false) {
      return false;
    }
    try {
      getTraktAppCredentials();
    } catch (e) {
      if (e instanceof TraktNotConfiguredError) {
        return false;
      }
      throw e;
    }
    try {
      await createTraktUserClient(userId);
      return true;
    } catch (e) {
      return traktAvailabilityFromError(e);
    }
  }

  async getStatus(
    userId: number,
    item: MediaItemRef
  ): Promise<MediaActionStatus> {
    const client = await createTraktUserClient(userId);
    const status = await getCachedItemStatus(
      client,
      userId,
      item.mediaType,
      item.tmdbId
    );
    return toStatus(status.watched, status.rating);
  }

  async getStatuses(
    userId: number,
    items: MediaItemRef[]
  ): Promise<(MediaItemRef & MediaActionStatus)[]> {
    if (items.length === 0) {
      return [];
    }
    const client = await createTraktUserClient(userId);
    const snapshot = await warmUserSyncCache(client, userId);
    return items.map((item) => {
      const status = lookupItemStatus(snapshot, item.mediaType, item.tmdbId);
      return {
        ...item,
        ...toStatus(status.watched, status.rating),
      };
    });
  }

  async markWatched(
    userId: number,
    item: MediaItemRef,
    options: MarkWatchedOptions = {}
  ): Promise<MediaActionStatus> {
    const client = await createTraktUserClient(userId);
    // Cache may be stale — always hit Trakt's watched endpoint; never skip/flip.
    const current = await getCachedItemStatus(
      client,
      userId,
      item.mediaType,
      item.tmdbId
    );
    const rating =
      options.ratingStars != null
        ? ratingStarsToProvider(options.ratingStars)
        : null;

    await client.addToHistory(
      item.mediaType,
      item.tmdbId,
      watchedAtIso(options.watchedAt)
    );
    if (rating != null) {
      await client.addRating(item.mediaType, item.tmdbId, rating);
    }

    const finalRating = rating ?? current.rating;
    patchUserSyncItem(userId, item.mediaType, item.tmdbId, {
      watched: true,
      ...(rating != null ? { rating } : {}),
    });
    return toStatus(true, finalRating);
  }

  async unmarkWatched(
    userId: number,
    item: MediaItemRef,
    options: UnmarkWatchedOptions = {}
  ): Promise<MediaActionStatus> {
    const client = await createTraktUserClient(userId);
    // Cache may be stale — always hit Trakt's unwatched endpoint; never skip/flip.
    const current = await getCachedItemStatus(
      client,
      userId,
      item.mediaType,
      item.tmdbId
    );

    await client.removeFromHistory(item.mediaType, item.tmdbId);
    if (options.removeRating) {
      await client.removeRating(item.mediaType, item.tmdbId);
    }

    const finalRating = options.removeRating ? null : current.rating;
    patchUserSyncItem(userId, item.mediaType, item.tmdbId, {
      watched: false,
      ...(options.removeRating ? { rating: null } : {}),
    });
    return toStatus(false, finalRating);
  }

  async rate(
    userId: number,
    item: MediaItemRef,
    options: RateOptions
  ): Promise<MediaActionStatus> {
    const rating = ratingStarsToProvider(options.ratingStars);
    const client = await createTraktUserClient(userId);
    const current = await getCachedItemStatus(
      client,
      userId,
      item.mediaType,
      item.tmdbId
    );
    await client.addRating(item.mediaType, item.tmdbId, rating);
    patchUserSyncItem(userId, item.mediaType, item.tmdbId, { rating });
    return toStatus(current.watched, rating);
  }
}
