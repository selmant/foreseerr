export class AnilistRateLimitedError extends Error {
  public readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds = 60) {
    super(`AniList API rate limited; retry after ${retryAfterSeconds}s`);
    this.name = 'AnilistRateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class AnilistAuthError extends Error {
  constructor(
    message = 'AniList authorization expired; reconnect your account'
  ) {
    super(message);
    this.name = 'AnilistAuthError';
  }
}

export class AnilistGraphQLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnilistGraphQLError';
  }
}

export class AnilistOutageError extends Error {
  constructor(message = 'AniList is temporarily unavailable') {
    super(message);
    this.name = 'AnilistOutageError';
  }
}

const OUTAGE_MESSAGE =
  /temporarily disabled|stability issues|service unavailable|under maintenance/i;

export function firstAnilistGraphQlError(data: unknown): {
  status?: number;
  message?: string;
} {
  if (!data || typeof data !== 'object' || !('errors' in data)) {
    return {};
  }
  const errors = (data as { errors?: { message?: string; status?: number }[] })
    .errors;
  const first = errors?.[0];
  if (!first) {
    return {};
  }
  return { status: first.status, message: first.message };
}

/**
 * AniList uses HTTP/GraphQL 403 both for a dead token and for "the API is
 * down." The default auth error told every client to reconnect when the
 * public API was just disabled.
 */
export function classifyAnilistFailure(options: {
  httpStatus?: number;
  graphQlStatus?: number;
  message?: string;
}): Error | undefined {
  const message = options.message?.trim() ?? '';
  if (OUTAGE_MESSAGE.test(message)) {
    return new AnilistOutageError(message);
  }
  const status = options.graphQlStatus ?? options.httpStatus;
  if (status === 401 || status === 403) {
    return message ? new AnilistAuthError(message) : new AnilistAuthError();
  }
  return undefined;
}
