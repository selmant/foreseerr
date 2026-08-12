import { providerRatingToStars } from './score';
import type {
  MarkWatchedOptions,
  MediaActionAggregate,
  MediaActionItemAvailability,
  MediaActionOperationCapability,
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

function unavailableReason(
  providers: MediaActionProviderResult[],
  matching: MediaActionProviderResult[]
): MediaActionItemAvailability['watched']['reason'] {
  if (matching.some((provider) => provider.ok)) {
    return undefined;
  }
  if (matching.length === 0) {
    return providers.length > 0 ? 'unsupported' : 'no_provider';
  }
  if (
    matching.every(
      (provider) => provider.error === 'No Jellyfin mapping for item'
    )
  ) {
    return 'not_mapped';
  }
  return 'provider_error';
}

function actionAvailability(
  providers: MediaActionProviderResult[],
  providerDefinitions: MediaActionProvider[]
): MediaActionItemAvailability {
  const forOperation = (capability: MediaActionOperationCapability) => {
    const matching = providers.filter((result) =>
      providerDefinitions.some(
        (provider) =>
          provider.id === result.provider && provider.capabilities[capability]
      )
    );
    const available = matching.some((provider) => provider.ok);
    const reason = available
      ? undefined
      : unavailableReason(providers, matching);
    return reason ? { available, reason } : { available };
  };

  return {
    watched: forOperation('writeWatched'),
    rating: forOperation('writeRating'),
  };
}

function withStars(status: MediaActionStatus): MediaActionStatus {
  return {
    watched: status.watched,
    rating: status.rating,
    ratingStars: status.ratingStars ?? providerRatingToStars(status.rating),
    ...(status.error ? { error: status.error } : {}),
  };
}

function supportsRead(provider: MediaActionProvider): boolean {
  return provider.capabilities.readWatched || provider.capabilities.readRating;
}

/**
 * Aggregation policy:
 * - watched: any successful provider reports watched
 * - rating: first successful rating-capable provider with a non-null rating
 */
function aggregateFromProviders(
  item: MediaItemRef,
  providers: MediaActionProviderResult[],
  providerDefinitions: MediaActionProvider[]
): MediaActionAggregate {
  const successful = providers.filter((p) => p.ok);
  const watched = successful.some((provider) => provider.watched);
  const ratingProvider = successful.find((provider) => provider.rating != null);
  const status = ratingProvider
    ? withStars({
        watched,
        rating: ratingProvider.rating,
        ratingStars: ratingProvider.ratingStars,
      })
    : withStars({
        watched,
        rating: null,
        ratingStars: null,
      });

  return {
    tmdbId: item.tmdbId,
    mediaType: item.mediaType,
    ...status,
    providers,
    actions: actionAvailability(providers, providerDefinitions),
  };
}

async function filterAvailableProviders(
  providers: MediaActionProvider[],
  userId: number,
  capability?: MediaActionOperationCapability
): Promise<MediaActionProvider[]> {
  const enabled: MediaActionProvider[] = [];
  for (const provider of providers) {
    if (capability && !provider.capabilities[capability]) {
      continue;
    }
    if (await provider.isAvailable(userId)) {
      enabled.push(provider);
    }
  }
  return enabled;
}

async function runOnProviders(
  providers: MediaActionProvider[],
  userId: number,
  item: MediaItemRef,
  capability: MediaActionOperationCapability,
  action: (provider: MediaActionProvider) => Promise<MediaActionStatus>
): Promise<MediaActionAggregate> {
  const enabled = await filterAvailableProviders(providers, userId, capability);

  if (enabled.length === 0) {
    return {
      tmdbId: item.tmdbId,
      mediaType: item.mediaType,
      ...emptyStatus(),
      providers: [],
      actions: actionAvailability([], providers),
    };
  }

  const results = await Promise.all(
    enabled.map(async (provider): Promise<MediaActionProviderResult> => {
      try {
        const status = withStars(await action(provider));
        return { provider: provider.id, ok: !status.error, ...status };
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

  return aggregateFromProviders(item, results, providers);
}

export class MediaActionDispatcher {
  constructor(private readonly providers: MediaActionProvider[]) {}

  async getStatus(
    userId: number,
    item: MediaItemRef
  ): Promise<MediaActionAggregate> {
    const enabled = await filterAvailableProviders(this.providers, userId).then(
      (providers) => providers.filter(supportsRead)
    );

    if (enabled.length === 0) {
      return {
        tmdbId: item.tmdbId,
        mediaType: item.mediaType,
        ...emptyStatus(),
        providers: [],
        actions: actionAvailability([], this.providers),
      };
    }

    const results = await Promise.all(
      enabled.map(async (provider): Promise<MediaActionProviderResult> => {
        try {
          const status = withStars(await provider.getStatus(userId, item));
          return { provider: provider.id, ok: !status.error, ...status };
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

    return aggregateFromProviders(item, results, this.providers);
  }

  async getStatuses(
    userId: number,
    items: MediaItemRef[]
  ): Promise<MediaActionAggregate[]> {
    if (items.length === 0) {
      return [];
    }

    const enabled = (
      await filterAvailableProviders(this.providers, userId)
    ).filter(supportsRead);

    if (enabled.length === 0) {
      return items.map((item) => ({
        tmdbId: item.tmdbId,
        mediaType: item.mediaType,
        ...emptyStatus(),
        providers: [],
        actions: actionAvailability([], this.providers),
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
          const returned = new Set<string>();
          for (const status of statuses) {
            const key = `${status.mediaType}:${status.tmdbId}`;
            const list = byKey.get(key);
            if (!list) continue;
            returned.add(key);
            list.push({
              provider: provider.id,
              ok: !status.error,
              ...withStars(status),
            });
          }
          for (const item of items) {
            const key = `${item.mediaType}:${item.tmdbId}`;
            if (returned.has(key)) continue;
            byKey.get(key)?.push({
              provider: provider.id,
              ok: false,
              ...emptyStatus(),
              error: 'Provider did not return a status for item',
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
        byKey.get(`${item.mediaType}:${item.tmdbId}`) ?? [],
        this.providers
      )
    );
  }

  async markWatched(
    userId: number,
    item: MediaItemRef,
    options?: MarkWatchedOptions
  ): Promise<MediaActionAggregate> {
    return runOnProviders(this.providers, userId, item, 'writeWatched', (p) =>
      p.markWatched(userId, item, options)
    );
  }

  async unmarkWatched(
    userId: number,
    item: MediaItemRef,
    options?: UnmarkWatchedOptions
  ): Promise<MediaActionAggregate> {
    return runOnProviders(this.providers, userId, item, 'writeWatched', (p) =>
      p.unmarkWatched(userId, item, options)
    );
  }

  async rate(
    userId: number,
    item: MediaItemRef,
    options: RateOptions
  ): Promise<MediaActionAggregate> {
    return runOnProviders(this.providers, userId, item, 'writeRating', (p) =>
      p.rate(userId, item, options)
    );
  }
}
