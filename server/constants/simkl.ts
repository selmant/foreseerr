import type { SimklSettings } from '@server/lib/settings';

/**
 * Foreseerr's own Simkl AUTH V2 app ("TV, devices & command line", no
 * secret). Simkl wants one Client ID per app rather than one per install:
 * AUTH V2 counts quota per user, and a public client ID is meant to ship.
 */
export const SIMKL_BUILTIN_CLIENT_ID =
  '7bb0499fc59c9bbd0f6112270b389aa2500efd1b0c2d47ee7167358c9c056b38';

/**
 * An install's own Client ID from before Foreseerr shipped its own app, or
 * `''`. New ones can't be set; an existing one keeps its linked accounts.
 */
export const legacySimklClientId = (clientId?: string): string => {
  const trimmed = clientId?.trim() ?? '';
  return trimmed === SIMKL_BUILTIN_CLIENT_ID ? '' : trimmed;
};

/** The Client ID in use: an install's legacy one, else the built-in one. */
export const simklClientIdFor = (clientId?: string): string =>
  clientId?.trim() || SIMKL_BUILTIN_CLIENT_ID;

/** The Client ID Simkl calls use, or `''` while Simkl is turned off. */
export const effectiveSimklClientId = (
  simkl?: Partial<SimklSettings>
): string =>
  simkl?.enabled === false ? '' : simklClientIdFor(simkl?.clientId);
