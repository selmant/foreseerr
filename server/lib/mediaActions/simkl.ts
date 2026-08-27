import { getRepository } from '@server/datasource';
import { SimklSyncItem } from '@server/entity/SimklSyncItem';
import { getSettings } from '@server/lib/settings';
import { createSimklUserClient, getUserSimklSettings } from '@server/lib/simkl';
import { syncSimklUser } from '@server/lib/simklSync';
import { providerRatingToStars, ratingStarsToProvider } from './score';
import {
  SIMKL_MEDIA_ACTION_CAPABILITIES,
  type MarkWatchedOptions,
  type MediaActionProvider,
  type MediaActionStatus,
  type MediaItemRef,
  type RateOptions,
  type UnmarkWatchedOptions,
} from './types';

const statusFrom = (item?: SimklSyncItem): MediaActionStatus => ({
  watched: Boolean(item?.lastWatchedAt),
  rating: item?.userRating ?? null,
  ratingStars: providerRatingToStars(item?.userRating),
});

export class SimklMediaActionProvider implements MediaActionProvider {
  readonly id = 'simkl' as const;
  readonly capabilities = SIMKL_MEDIA_ACTION_CAPABILITIES;

  async isAvailable(userId: number): Promise<boolean> {
    if (getSettings().mediaActions.providers.simkl === false) return false;
    const settings = await getUserSimklSettings(userId);
    return Boolean(
      settings?.simklAccessToken && settings.mediaActionsSimklEnabled !== false
    );
  }

  private async item(
    userId: number,
    ref: MediaItemRef
  ): Promise<SimklSyncItem | undefined> {
    await syncSimklUser(userId);
    return (
      (await getRepository(SimklSyncItem).findOne({
        where: {
          user: { id: userId },
          tmdbId: ref.tmdbId,
          simklType: ref.mediaType === 'movie' ? 'movie' : 'show',
        },
        order: { lastWatchedAt: 'DESC' },
      })) ?? undefined
    );
  }

  async getStatus(
    userId: number,
    item: MediaItemRef
  ): Promise<MediaActionStatus> {
    return statusFrom(await this.item(userId, item));
  }

  async getStatuses(userId: number, items: MediaItemRef[]) {
    await syncSimklUser(userId);
    return Promise.all(
      items.map(async (item) => ({
        ...item,
        ...statusFrom(await this.item(userId, item)),
      }))
    );
  }

  async markWatched(
    userId: number,
    item: MediaItemRef,
    options: MarkWatchedOptions = {}
  ): Promise<MediaActionStatus> {
    const client = await createSimklUserClient(userId);
    await client.addHistory(item.mediaType, item.tmdbId);
    if (options.ratingStars != null)
      await client.setRating(
        item.mediaType,
        item.tmdbId,
        ratingStarsToProvider(options.ratingStars)
      );
    await syncSimklUser(userId, true);
    return this.getStatus(userId, item);
  }

  async unmarkWatched(
    userId: number,
    item: MediaItemRef,
    options: UnmarkWatchedOptions = {}
  ): Promise<MediaActionStatus> {
    const client = await createSimklUserClient(userId);
    await client.removeHistory(item.mediaType, item.tmdbId);
    if (options.removeRating)
      await client.removeRating(item.mediaType, item.tmdbId);
    await syncSimklUser(userId, true);
    return this.getStatus(userId, item);
  }

  async rate(
    userId: number,
    item: MediaItemRef,
    options: RateOptions
  ): Promise<MediaActionStatus> {
    const client = await createSimklUserClient(userId);
    await client.setRating(
      item.mediaType,
      item.tmdbId,
      ratingStarsToProvider(options.ratingStars)
    );
    await syncSimklUser(userId, true);
    return this.getStatus(userId, item);
  }
}
