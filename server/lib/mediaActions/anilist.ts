import {
  AnilistNotConfiguredError,
  anilistAvailabilityFromError,
  createAnilistUserClient,
  getAnilistAppCredentials,
  getUserAnilistSettings,
} from '@server/lib/anilist';
import anilistIdMapping from '@server/lib/anilist/mapping';
import { getAnilistUserContext } from '@server/lib/anilist/userContext';
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
  type UnmarkWatchedOptions,
} from './types';

export const ANILIST_NOT_MAPPED_ERROR = 'No AniList mapping for item';

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

function unmappedStatus(): MediaActionStatus {
  return { ...emptyStatus(), error: ANILIST_NOT_MAPPED_ERROR };
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
      return unmappedStatus();
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
    await anilistIdMapping.sync();
    return Promise.all(
      items.map(async (item) => {
        if (
          !(await anilistIdMapping.getAnilistId(item.mediaType, item.tmdbId))
        ) {
          return { ...item, ...unmappedStatus() };
        }
        const status = lookupAnilistItemStatus(
          snapshot,
          item.mediaType,
          item.tmdbId
        );
        return {
          ...item,
          ...toStatus(status.watched, status.rating),
        };
      })
    );
  }

  async markWatched(
    userId: number,
    item: MediaItemRef,
    options: MarkWatchedOptions = {}
  ): Promise<MediaActionStatus> {
    const mapped = await this.resolveMappedItem(item);
    if (!mapped) {
      return unmappedStatus();
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
    item: MediaItemRef,
    options: UnmarkWatchedOptions = {}
  ): Promise<MediaActionStatus> {
    const mapped = await this.resolveMappedItem(item);
    if (!mapped) {
      return unmappedStatus();
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
    let saved: Awaited<ReturnType<typeof client.saveMediaListEntry>> | null =
      null;
    if (entryId && options.removeRating) {
      await client.deleteMediaListEntry(entryId);
    } else if (entryId) {
      // AniList stores watched state in the list status. Move the entry back
      // to planning while retaining its score and list membership unless the
      // caller explicitly asks to remove the rating.
      saved = await client.saveMediaListEntry({
        mediaId: mapped.anilistId,
        status: 'PLANNING',
        ...(current.rating != null
          ? { scoreRaw: providerRatingToScoreRaw(current.rating) }
          : {}),
      });
    }

    const rating = options.removeRating ? null : current.rating;

    patchUserAnilistSyncItem(userId, item.mediaType, item.tmdbId, {
      watched: false,
      status: saved?.status ?? (options.removeRating ? null : 'PLANNING'),
      rating,
      anilistId: mapped.anilistId,
      // A default unwatch with no existing list entry must not create a
      // synthetic planning entry in the optimistic cache.
      listEntryId: saved?.id ?? entryId ?? null,
    });

    return toStatus(false, rating);
  }

  async rate(
    userId: number,
    item: MediaItemRef,
    options: RateOptions
  ): Promise<MediaActionStatus> {
    const mapped = await this.resolveMappedItem(item);
    if (!mapped) {
      return unmappedStatus();
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
    return getAnilistUserContext(userId);
  }

  private async resolveMappedItem(
    item: MediaItemRef
  ): Promise<{ anilistId: number } | null> {
    await anilistIdMapping.sync();
    const anilistId = await anilistIdMapping.getAnilistId(
      item.mediaType,
      item.tmdbId
    );
    if (!anilistId) {
      return null;
    }
    return { anilistId };
  }
}
