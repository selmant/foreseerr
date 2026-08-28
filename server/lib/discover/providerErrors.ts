import { AnilistAuthError, AnilistRateLimitedError } from '@server/api/anilist';
import {
  MdblistListNotFoundError,
  MdblistNotConfiguredError,
  MdblistUnavailableError,
} from '@server/api/mdblist';
import {
  TraktAppAccessDeniedError,
  TraktRateLimitedError,
  TraktReconnectRequiredError,
} from '@server/api/trakt';
import {
  AnilistNotConfiguredError,
  AnilistNotLinkedError,
} from '@server/lib/anilist';
import {
  TraktNotConfiguredError,
  TraktNotLinkedError,
} from '@server/lib/trakt';
import { handleDiscoverRouteError } from './routeErrors';

type Next = (err?: unknown) => void;

export const handleTraktDiscoverRouteError = (
  error: unknown,
  next: Next,
  fallbackMessage: string
) =>
  handleDiscoverRouteError(error, next, fallbackMessage, [
    {
      matches: (value) => value instanceof TraktNotConfiguredError,
      status: 400,
    },
    { matches: (value) => value instanceof TraktNotLinkedError, status: 404 },
    // Unauthenticated Trakt access is dead, so the app client failing means the
    // same thing to the caller as an unlinked account: link one to proceed.
    {
      matches: (value) => value instanceof TraktAppAccessDeniedError,
      status: 404,
    },
    {
      matches: (value) => value instanceof TraktReconnectRequiredError,
      status: 401,
    },
    {
      matches: (value) => value instanceof TraktRateLimitedError,
      status: 429,
      retryAfter: (value) =>
        value instanceof TraktRateLimitedError
          ? value.retryAfterSeconds
          : undefined,
    },
  ]);

export const handleMdblistDiscoverRouteError = (
  error: unknown,
  next: Next,
  fallbackMessage: string
) =>
  handleDiscoverRouteError(error, next, fallbackMessage, [
    {
      matches: (value) => value instanceof MdblistNotConfiguredError,
      status: 400,
    },
    {
      matches: (value) => value instanceof MdblistListNotFoundError,
      status: 404,
    },
    {
      matches: (value) => value instanceof MdblistUnavailableError,
      status:
        error instanceof Error && /quota/i.test(error.message) ? 429 : 503,
    },
    {
      matches: (value) =>
        value instanceof Error && /list (url|reference)/i.test(value.message),
      status: 400,
    },
  ]);

export const handleAnilistDiscoverRouteError = (
  error: unknown,
  next: Next,
  fallbackMessage: string
) =>
  handleDiscoverRouteError(error, next, fallbackMessage, [
    {
      matches: (value) => value instanceof AnilistNotConfiguredError,
      status: 400,
    },
    { matches: (value) => value instanceof AnilistNotLinkedError, status: 404 },
    { matches: (value) => value instanceof AnilistAuthError, status: 401 },
    {
      matches: (value) => value instanceof AnilistRateLimitedError,
      status: 429,
      retryAfter: (value) =>
        value instanceof AnilistRateLimitedError
          ? value.retryAfterSeconds
          : undefined,
    },
  ]);
