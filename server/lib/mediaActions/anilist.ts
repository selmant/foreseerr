import {
  AnilistNotConfiguredError,
  AnilistNotLinkedError,
  anilistAvailabilityFromError,
  createAnilistUserClient,
  getAnilistAppCredentials,
  getUserAnilistSettings,
} from '@server/lib/anilist';
import anilistIdMapping from '@server/lib/anilist/mapping';
import { getSettings } from '@server/lib/settings';
import {
  lookupAnilistItemStatus,
  patchUserAnilistSyncItem,
  providerRatingToScoreRaw,
  warmUserAnilistSyncCache,
} from './anilistSyncCache';
import { providerRatingToStars, ratingStarsToProvider } from './score';
import {
  ANILIST_MEDIA_ACTION_CAPABILITIES,
  type MarkWatchedOptions,
  type MediaActionProvider,
  type MediaActionStatus,
  type MediaItemRef,
  type RateOptions,
} from './types';

function toStatus(watched: boolean, rating: number | null): MediaActionStatus {
  return {
    watched,
    rating,
    ratingStars: providerRatingToStars(rating),
  };
}

function emptyStatus(): MediaActionStatus {
  return toStatus(false, null);
}

export class AnilistMediaActionProvider implements MediaActionProvider {
  readonly id = 'anilist' as const;
  readonly capabilities = ANILIST_MEDIA_ACTION_CAPABILITIES;

  async isAvailable(userId: number): Promise<boolean> {
    const settings = getSettings();
    if (settings.mediaActions?.providers?.anilist === false) {
      return false;
    }
    try {
      getAnilistAppCredentials();
    } catch (e) {
      if (e instanceof AnilistNotConfiguredError) {
        return false;
      }
      throw e;
    }
    const userSettings = await getUserAnilistSettings(userId);
    if (userSettings?.mediaActionsAnilistEnabled === false) {
      return false;
    }
    try {
      await createAnilistUserClient(userId);
      return true;
    } catch (e) {
      return anilistAvailabilityFromError(e);
    }
  }

  async getStatus(
    userId: number,
    item: MediaItemRef
  ): Promise<MediaActionStatus> {
    const mapped = await this.resolveMappedItem(item);
    if (!mapped) {
      return emptyStatus();
    }
    const { client, anilistUserId } = await this.getClientContext(userId);
    const snapshot = await warmUserAnilistSyncCache(
      client,
      userId,
      anilistUserId
    );
    const status = lookupAnilistItemStatus(
      snapshot,
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
    const { client, anilistUserId } = await this.getClientContext(userId);
    const snapshot = await warmUserAnilistSyncCache(
      client,
      userId,
      anilistUserId
    );
    return items.map((item) => {
      const status = lookupAnilistItemStatus(
        snapshot,
        item.mediaType,
        item.tmdbId
      );
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
    const mapped = await this.resolveMappedItem(item);
    if (!mapped) {
      return emptyStatus();
    }

    const { client, anilistUserId } = await this.getClientContext(userId);
    const snapshot = await warmUserAnilistSyncCache(
      client,
      userId,
      anilistUserId
    );
    const current = lookupAnilistItemStatus(
      snapshot,
      item.mediaType,
      item.tmdbId
    );
    const rating =
      options.ratingStars != null
        ? ratingStarsToProvider(options.ratingStars)
        : null;

    const saved = await client.saveMediaListEntry({
      mediaId: mapped.anilistId,
      status: 'COMPLETED',
      ...(rating != null ? { scoreRaw: providerRatingToScoreRaw(rating) } : {}),
    });

    const finalRating = rating ?? current.rating;
    patchUserAnilistSyncItem(userId, item.mediaType, item.tmdbId, {
      watched: true,
      status: 'COMPLETED',
      anilistId: mapped.anilistId,
      listEntryId: saved?.id ?? current.entry?.listEntryId ?? null,
      ...(rating != null ? { rating } : {}),
    });

    return toStatus(true, finalRating);
  }

  async unmarkWatched(
    userId: number,
    item: MediaItemRef
  ): Promise<MediaActionStatus> {
    const mapped = await this.resolveMappedItem(item);
    if (!mapped) {
      return emptyStatus();
    }

    const { client, anilistUserId } = await this.getClientContext(userId);
    const snapshot = await warmUserAnilistSyncCache(
      client,
      userId,
      anilistUserId
    );
    const current = lookupAnilistItemStatus(
      snapshot,
      item.mediaType,
      item.tmdbId
    );
    const entryId = current.entry?.listEntryId;
    if (entryId) {
      await client.deleteMediaListEntry(entryId);
    }

    patchUserAnilistSyncItem(userId, item.mediaType, item.tmdbId, {
      watched: false,
      status: null,
      rating: null,
      anilistId: mapped.anilistId,
      listEntryId: null,
    });

    return emptyStatus();
  }

  async rate(
    userId: number,
    item: MediaItemRef,
    options: RateOptions
  ): Promise<MediaActionStatus> {
    const mapped = await this.resolveMappedItem(item);
    if (!mapped) {
      return emptyStatus();
    }

    const { client, anilistUserId } = await this.getClientContext(userId);
    const snapshot = await warmUserAnilistSyncCache(
      client,
      userId,
      anilistUserId
    );
    const current = lookupAnilistItemStatus(
      snapshot,
      item.mediaType,
      item.tmdbId
    );
    const rating = ratingStarsToProvider(options.ratingStars);
    const saved = await client.saveMediaListEntry({
      mediaId: mapped.anilistId,
      scoreRaw: providerRatingToScoreRaw(rating),
      ...(current.entry ? {} : { status: 'PLANNING' }),
    });

    patchUserAnilistSyncItem(userId, item.mediaType, item.tmdbId, {
      watched: current.watched,
      status: saved?.status ?? current.entry?.status ?? 'PLANNING',
      rating,
      anilistId: mapped.anilistId,
      listEntryId: saved?.id ?? current.entry?.listEntryId ?? null,
    });

    return toStatus(current.watched, rating);
  }

  private async getClientContext(userId: number): Promise<{
    client: Awaited<ReturnType<typeof createAnilistUserClient>>;
    anilistUserId: number;
  }> {
    const client = await createAnilistUserClient(userId);
    const settings = await getUserAnilistSettings(userId);
    const anilistUserId = Number(settings?.anilistUserId);
    if (!Number.isFinite(anilistUserId) || anilistUserId <= 0) {
      throw new AnilistNotLinkedError();
    }
    return { client, anilistUserId };
  }

  private async resolveMappedItem(
    item: MediaItemRef
  ): Promise<{ anilistId: number } | null> {
    await anilistIdMapping.sync();
    const anilistId = anilistIdMapping.getAnilistId(
      item.mediaType,
      item.tmdbId
    );
    if (!anilistId) {
      return null;
    }
    return { anilistId };
  }
}
