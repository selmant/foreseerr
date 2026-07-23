import { MediaActionDispatcher } from './dispatcher';
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
  return [new TraktMediaActionProvider()];
}

export function getMediaActionDispatcher(): MediaActionDispatcher {
  if (!defaultDispatcher) {
    defaultDispatcher = new MediaActionDispatcher(
      getDefaultMediaActionProviders()
    );
  }
  return defaultDispatcher;
}

/** Test helper to inject providers. */
export function createMediaActionDispatcher(
  providers: MediaActionProvider[]
): MediaActionDispatcher {
  return new MediaActionDispatcher(providers);
}
