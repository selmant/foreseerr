import { prepareFilterValues } from '@app/components/Discover/constants';
import { discoverDefaultsRequestExtras } from '@app/components/Discover/mergeFilterDefaults';
import type { ParsedUrlQuery } from 'querystring';

export function prepareTraktDiscoverOptions(
  query: ParsedUrlQuery,
  extraKeys: string[] = [],
  userId?: number
): Record<string, string> {
  const options: Record<string, string> = {
    ...discoverDefaultsRequestExtras(userId),
  };

  if (query.type === 'movie' || query.type === 'tv' || query.type === 'anime') {
    options.type = query.type;
  }
  if (query.ignoreCollected === 'true' || query.ignoreCollected === 'false') {
    options.ignoreCollected = query.ignoreCollected;
  }
  if (
    query.ignoreWatchlisted === 'true' ||
    query.ignoreWatchlisted === 'false'
  ) {
    options.ignoreWatchlisted = query.ignoreWatchlisted;
  }
  if (query.hideUnmapped === 'true' || query.hideUnmapped === 'false') {
    options.hideUnmapped = query.hideUnmapped;
  }
  if (query.ignoreWatched === 'true') {
    options.ignoreWatched = 'true';
  } else if (query.ignoreWatched === 'false') {
    options.ignoreWatched = 'false';
  }

  for (const key of extraKeys) {
    const value = query[key];
    if (typeof value === 'string' && value) {
      options[key] = value;
    }
  }

  const filters = prepareFilterValues(query);
  for (const [key, value] of Object.entries(filters)) {
    if (
      typeof value === 'string' &&
      value &&
      key !== 'ignoreWatched' &&
      key !== 'ignoreCollected' &&
      key !== 'ignoreWatchlisted' &&
      key !== 'hideUnmapped'
    ) {
      options[key] = value;
    }
  }

  return options;
}
