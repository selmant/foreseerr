import { MediaActionDispatcher } from './dispatcher';
import { JellyfinMediaActionProvider } from './jellyfin';
import { TraktMediaActionProvider } from './trakt';
import type { MediaActionProvider } from './types';

export { getMediaActionCapabilities } from './capabilities';
export type {
  MediaActionCapabilitiesResponse,
  MediaActionProviderCapability,
  MediaActionSurfaceCapabilities,
} from './capabilities';
export { MediaActionDispatcher } from './dispatcher';
export * from './score';
export {
  clearSyncCache,
  invalidateUserSyncCache,
  patchUserSyncItem,
} from './syncCache';
export { TraktMediaActionProvider } from './trakt';
export * from './types';
export { classifyWriteOutcome, writeHttpStatus } from './writeOutcome';

let defaultDispatcher: MediaActionDispatcher | null = null;
let defaultProviders: MediaActionProvider[] | null = null;

export function getDefaultMediaActionProviders(): MediaActionProvider[] {
  if (!defaultProviders) {
    defaultProviders = [
      new TraktMediaActionProvider(),
      new JellyfinMediaActionProvider(),
    ];
  }
  return defaultProviders;
}

export function getMediaActionDispatcher(): MediaActionDispatcher {
  if (!defaultDispatcher) {
    defaultDispatcher = new MediaActionDispatcher(
      getDefaultMediaActionProviders()
    );
  }
  return defaultDispatcher;
}
