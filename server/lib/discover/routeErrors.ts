import logger from '@server/logger';

type Next = (error?: unknown) => void;

export interface DiscoverRouteErrorRule {
  matches: (error: unknown) => boolean;
  status: number;
  message?: (error: unknown) => string;
  retryAfter?: (error: unknown) => number | undefined;
}

/**
 * Convert provider-specific failures to the common Express error shape used
 * by Discover routes. Keeping retry metadata in this shared path prevents
 * rate-limit handlers from silently dropping Retry-After information when a
 * provider gets a second route family.
 */
export function handleDiscoverRouteError(
  error: unknown,
  next: Next,
  fallbackMessage: string,
  rules: readonly DiscoverRouteErrorRule[]
): void {
  const rule = rules.find((candidate) => candidate.matches(error));
  if (rule) {
    const retryAfter = rule.retryAfter?.(error);
    next({
      status: rule.status,
      message: rule.message?.(error) ?? errorMessage(error),
      ...(retryAfter === undefined ? {} : { retryAfter }),
    });
    return;
  }

  logger.error(fallbackMessage, {
    label: 'API',
    errorMessage: errorMessage(error),
  });
  next({ status: 500, message: fallbackMessage });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
