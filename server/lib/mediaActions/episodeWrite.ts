import type {
  MediaActionAggregate,
  MediaActionProviderId,
  MediaActionProviderResult,
} from './types';

/** Normalize episode-provider fan-out to the same aggregate contract as title writes. */
export function episodeWriteResult(
  provider: MediaActionProviderId,
  watched: boolean,
  write: Promise<boolean | 'skipped'>
): Promise<MediaActionProviderResult | null> {
  return write
    .then((result) => {
      if (result === 'skipped') return null;
      return {
        provider,
        ok: result,
        watched: result ? watched : !watched,
        rating: null,
        ratingStars: null,
        ...(result ? {} : { error: `${provider} episode update was rejected` }),
      };
    })
    .catch(
      (error): MediaActionProviderResult => ({
        provider,
        ok: false,
        watched: !watched,
        rating: null,
        ratingStars: null,
        error: error instanceof Error ? error.message : 'unknown error',
      })
    );
}

export function episodeWriteAggregate(
  tmdbId: number,
  watched: boolean,
  providers: MediaActionProviderResult[]
): MediaActionAggregate {
  const writeSucceeded = providers.some((provider) => provider.ok);
  return {
    tmdbId,
    mediaType: 'tv',
    watched,
    rating: null,
    ratingStars: null,
    providers,
    actions: {
      watched: writeSucceeded
        ? { available: true }
        : {
            available: false,
            reason: providers.length === 0 ? 'no_provider' : 'provider_error',
          },
      rating: { available: false, reason: 'unsupported' },
    },
  };
}
