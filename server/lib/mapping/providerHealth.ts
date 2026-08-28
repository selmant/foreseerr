import { TraktAppAccessDeniedError } from '@server/api/trakt';
import {
  TraktNotConfiguredError,
  createTraktAppClient,
} from '@server/lib/trakt';

/**
 * Health of the provider access the mapping layer depends on but does not own.
 *
 * Trakt is the most accurate source measured (976/979 correct), and it is also
 * the one whose access model changed under us: since 2026-07-30 a request
 * carrying only the application `client_id` is refused, so list search and
 * every slider for an unlinked user degrade. That is an operational fact the
 * health page has to state, because from the outside it looks like a mapping
 * failure.
 */
export interface ProviderHealth {
  key: string;
  state: 'ok' | 'failing' | 'unconfigured';
  detail?: string;
  checkedAt: string;
}

/** Trakt's answer will not change minute to minute; probing it often would. */
const PROBE_TTL_MSEC = 30 * 60 * 1000;

let cached: { at: number; health: ProviderHealth } | undefined;

export const resetProviderHealthCache = (): void => {
  cached = undefined;
};

export async function traktAppClientHealth(
  options: { force?: boolean } = {}
): Promise<ProviderHealth> {
  if (!options.force && cached && Date.now() - cached.at < PROBE_TTL_MSEC) {
    return cached.health;
  }

  const checkedAt = new Date().toISOString();
  let health: ProviderHealth;
  try {
    // The same call the UI makes, so the page cannot claim health that list
    // search does not have.
    await createTraktAppClient().searchLists('foreseer', { limit: 1 });
    health = { key: 'trakt-app-client', state: 'ok', checkedAt };
  } catch (error) {
    if (error instanceof TraktNotConfiguredError) {
      health = {
        key: 'trakt-app-client',
        state: 'unconfigured',
        detail: 'No Trakt application credentials are configured.',
        checkedAt,
      };
    } else {
      health = {
        key: 'trakt-app-client',
        state: 'failing',
        detail:
          error instanceof TraktAppAccessDeniedError
            ? 'Trakt refuses unauthenticated requests; every Trakt slider needs a linked account.'
            : error instanceof Error
              ? error.message
              : 'unknown error',
        checkedAt,
      };
    }
  }

  cached = { at: Date.now(), health };
  return health;
}

export async function providerHealth(
  options: { force?: boolean } = {}
): Promise<ProviderHealth[]> {
  return [await traktAppClientHealth(options)];
}
