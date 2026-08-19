import { anilistEpisodeActions } from './anilistEpisodes';
import { getDefaultMediaActionProviders } from './index';
import { jellyfinEpisodeActions } from './jellyfin';
import { traktEpisodeActions } from './traktEpisodes';
import type {
  MediaActionOperationCapabilities,
  MediaActionProvider,
  MediaActionProviderId,
} from './types';

export interface MediaActionSurfaceCapabilities {
  watched: boolean;
  rating: boolean;
}

export interface MediaActionProviderCapability {
  id: MediaActionProviderId;
  linked: boolean;
  capabilities: MediaActionOperationCapabilities;
}

export interface MediaActionCapabilitiesResponse {
  movie: MediaActionSurfaceCapabilities;
  tv: MediaActionSurfaceCapabilities;
  episode: MediaActionSurfaceCapabilities;
  providers: MediaActionProviderCapability[];
}

function anyCapability(
  providers: MediaActionProviderCapability[],
  capability: keyof MediaActionOperationCapabilities
): boolean {
  return providers.some(
    (provider) => provider.linked && provider.capabilities[capability]
  );
}

export async function getMediaActionCapabilities(
  userId: number,
  providers: MediaActionProvider[] = getDefaultMediaActionProviders()
): Promise<MediaActionCapabilitiesResponse> {
  const providerCapabilities = await Promise.all(
    providers.map(async (provider) => ({
      id: provider.id,
      linked: await provider.isAvailable(userId),
      capabilities: provider.capabilities,
    }))
  );

  const [
    traktEpisodeAvailable,
    jellyfinEpisodeAvailable,
    anilistEpisodeAvailable,
  ] = await Promise.all([
    traktEpisodeActions.isAvailable(userId),
    jellyfinEpisodeActions.isAvailable(userId),
    anilistEpisodeActions.isAvailable(userId),
  ]);

  const titleWatched = anyCapability(providerCapabilities, 'writeWatched');
  const titleRating = anyCapability(providerCapabilities, 'writeRating');

  return {
    movie: {
      watched: titleWatched,
      rating: titleRating,
    },
    tv: {
      watched: titleWatched,
      rating: titleRating,
    },
    episode: {
      watched:
        traktEpisodeAvailable ||
        jellyfinEpisodeAvailable ||
        anilistEpisodeAvailable,
      rating: false,
    },
    providers: providerCapabilities,
  };
}
