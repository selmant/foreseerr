import type { AllSettings } from '@server/lib/settings';

type RequestTimeoutMigrationSettings = Omit<
  Partial<AllSettings>,
  'network' | 'migrations'
> & {
  network?: Partial<AllSettings['network']>;
  migrations?: string[];
};

const MIGRATION = '0013_increase_arr_request_timeout';
const PREVIOUS_DEFAULT_TIMEOUT = 10_000;
const ARR_REQUEST_TIMEOUT = 60_000;

/**
 * Arr operations can legitimately take longer than ten seconds, especially
 * while Sonarr or Radarr is busy. Only replace the old default so an
 * administrator's explicit timeout remains intact.
 */
const increaseArrRequestTimeout = (
  settings: RequestTimeoutMigrationSettings
): AllSettings => {
  if (
    Array.isArray(settings.migrations) &&
    settings.migrations.includes(MIGRATION)
  ) {
    return settings as AllSettings;
  }

  if (settings.network?.apiRequestTimeout === PREVIOUS_DEFAULT_TIMEOUT) {
    settings.network.apiRequestTimeout = ARR_REQUEST_TIMEOUT;
  }

  if (!Array.isArray(settings.migrations)) settings.migrations = [];
  settings.migrations.push(MIGRATION);
  return settings as AllSettings;
};

export default increaseArrRequestTimeout;
