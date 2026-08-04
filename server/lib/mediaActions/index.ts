import { MediaActionDispatcher } from './dispatcher';
import { JellyfinMediaActionProvider } from './jellyfin';
import { TraktMediaActionProvider } from './trakt';
import type { MediaActionProvider } from './types';

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

export function getDefaultMediaActionProviders(): MediaActionProvider[] {
  return [new TraktMediaActionProvider(), new JellyfinMediaActionProvider()];
}

export function getMediaActionDispatcher(): MediaActionDispatcher {
  if (!defaultDispatcher) {
    defaultDispatcher = new MediaActionDispatcher(
      getDefaultMediaActionProviders()
    );
  }
  return defaultDispatcher;
}
