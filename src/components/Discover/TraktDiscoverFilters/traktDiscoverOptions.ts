import type { ParsedUrlQuery } from 'querystring';

export function prepareTraktDiscoverOptions(
  query: ParsedUrlQuery,
  extraKeys: string[] = []
): Record<string, string> {
  const options: Record<string, string> = {};

  if (query.type === 'movie' || query.type === 'tv' || query.type === 'anime') {
    options.type = query.type;
  }
  if (query.ignoreCollected === 'true') {
    options.ignoreCollected = 'true';
  }
  if (query.ignoreWatchlisted === 'true') {
    options.ignoreWatchlisted = 'true';
  }

  for (const key of extraKeys) {
    const value = query[key];
    if (typeof value === 'string' && value) {
      options[key] = value;
    }
  }

  return options;
}
