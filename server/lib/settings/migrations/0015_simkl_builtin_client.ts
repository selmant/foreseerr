import type { AllSettings } from '@server/lib/settings';

type SimklMigrationSettings = Omit<
  Partial<AllSettings>,
  'simkl' | 'migrations'
> & {
  simkl?: Partial<AllSettings['simkl']>;
  migrations?: string[];
};

const MIGRATION = '0015_simkl_builtin_client';

/**
 * Foreseerr now ships its own Simkl Client ID, so Simkl no longer needs one
 * to be configured and defaults to on. An install that never set Simkl up
 * keeps it off until an administrator turns it on; one with a Client ID
 * keeps using it, and its linked accounts.
 */
const migrateSimklBuiltinClient = (
  settings: SimklMigrationSettings
): AllSettings => {
  if (
    Array.isArray(settings.migrations) &&
    settings.migrations.includes(MIGRATION)
  ) {
    return settings as AllSettings;
  }

  if (!settings.simkl) settings.simkl = {};
  if (typeof settings.simkl.enabled !== 'boolean') {
    settings.simkl.enabled = Boolean(settings.simkl.clientId?.trim());
  }

  if (!Array.isArray(settings.migrations)) settings.migrations = [];
  settings.migrations.push(MIGRATION);
  return settings as AllSettings;
};

export default migrateSimklBuiltinClient;
