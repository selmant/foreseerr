import { providerRatingToStars } from './score';
import type {
  MarkWatchedOptions,
  MediaActionAggregate,
  MediaActionProvider,
  MediaActionProviderResult,
  MediaActionStatus,
  MediaItemRef,
  RateOptions,
  UnmarkWatchedOptions,
} from './types';

function emptyStatus(): MediaActionStatus {
  return { watched: false, rating: null, ratingStars: null };
}

function withStars(status: MediaActionStatus): MediaActionStatus {
  return {
    watched: status.watched,
    rating: status.rating,
    ratingStars: status.ratingStars ?? providerRatingToStars(status.rating),
  };
}

function aggregateFromProviders(
  item: MediaItemRef,
  providers: MediaActionProviderResult[]
): MediaActionAggregate {
  const successful = providers.filter((p) => p.ok);
  // Prefer first successful provider for aggregate readout (Trakt is first today).
  const primary = successful[0];
  const status = primary
    ? withStars({
        watched: primary.watched,
        rating: primary.rating,
        ratingStars: primary.ratingStars,
      })
    : emptyStatus();

  return {
    tmdbId: item.tmdbId,
    mediaType: item.mediaType,
    ...status,
    providers,
  };
}

async function runOnProviders(
  providers: MediaActionProvider[],
  userId: number,
  item: MediaItemRef,
  action: (provider: MediaActionProvider) => Promise<MediaActionStatus>
): Promise<MediaActionAggregate> {
  const enabled: MediaActionProvider[] = [];
  for (const provider of providers) {
    if (await provider.isAvailable(userId)) {
      enabled.push(provider);
    }
  }

  if (enabled.length === 0) {
    return {
      tmdbId: item.tmdbId,
      mediaType: item.mediaType,
      ...emptyStatus(),
      providers: [],
    };
  }

  const results = await Promise.all(
    enabled.map(async (provider): Promise<MediaActionProviderResult> => {
      try {
        const status = withStars(await action(provider));
        return { provider: provider.id, ok: true, ...status };
      } catch (e) {
        return {
          provider: provider.id,
          ok: false,
          ...emptyStatus(),
          error: e instanceof Error ? e.message : 'unknown error',
        };
      }
    })
  );

  return aggregateFromProviders(item, results);
}

export class MediaActionDispatcher {
  constructor(private readonly providers: MediaActionProvider[]) {}

  async getStatus(
    userId: number,
    item: MediaItemRef
  ): Promise<MediaActionAggregate> {
    return runOnProviders(this.providers, userId, item, (p) =>
      p.getStatus(userId, item)
    );
  }

  async getStatuses(
    userId: number,
    items: MediaItemRef[]
  ): Promise<MediaActionAggregate[]> {
    if (items.length === 0) {
      return [];
    }

    const enabled: MediaActionProvider[] = [];
    for (const provider of this.providers) {
      if (await provider.isAvailable(userId)) {
        enabled.push(provider);
      }
    }

    if (enabled.length === 0) {
      return items.map((item) => ({
        tmdbId: item.tmdbId,
        mediaType: item.mediaType,
        ...emptyStatus(),
        providers: [],
      }));
    }

    // Batch per provider, then merge by item key.
    const byKey = new Map<string, MediaActionProviderResult[]>();
    for (const item of items) {
      byKey.set(`${item.mediaType}:${item.tmdbId}`, []);
    }

    await Promise.all(
      enabled.map(async (provider) => {
        try {
          const statuses = await provider.getStatuses(userId, items);
          for (const status of statuses) {
            const key = `${status.mediaType}:${status.tmdbId}`;
            const list = byKey.get(key);
            if (!list) continue;
            list.push({
              provider: provider.id,
              ok: true,
              ...withStars(status),
            });
          }
        } catch (e) {
          const error = e instanceof Error ? e.message : 'unknown error';
          for (const item of items) {
            const key = `${item.mediaType}:${item.tmdbId}`;
            byKey.get(key)?.push({
              provider: provider.id,
              ok: false,
              ...emptyStatus(),
              error,
            });
          }
        }
      })
    );

    return items.map((item) =>
      aggregateFromProviders(
        item,
        byKey.get(`${item.mediaType}:${item.tmdbId}`) ?? []
      )
    );
  }

  async markWatched(
    userId: number,
    item: MediaItemRef,
    options?: MarkWatchedOptions
  ): Promise<MediaActionAggregate> {
    return runOnProviders(this.providers, userId, item, (p) =>
      p.markWatched(userId, item, options)
    );
  }

  async unmarkWatched(
    userId: number,
    item: MediaItemRef,
    options?: UnmarkWatchedOptions
  ): Promise<MediaActionAggregate> {
    return runOnProviders(this.providers, userId, item, (p) =>
      p.unmarkWatched(userId, item, options)
    );
  }

  async rate(
    userId: number,
    item: MediaItemRef,
    options: RateOptions
  ): Promise<MediaActionAggregate> {
    return runOnProviders(this.providers, userId, item, (p) =>
      p.rate(userId, item, options)
    );
  }
}
