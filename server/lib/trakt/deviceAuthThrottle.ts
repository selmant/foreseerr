import type { NextFunction, Request, Response } from 'express';

export const TRAKT_DEVICE_CODE_MAX_PER_WINDOW = 5;
export const TRAKT_DEVICE_CODE_WINDOW_MS = 15 * 60 * 1000;
export const TRAKT_DEVICE_POLL_MAX_PER_MINUTE = 30;
export const TRAKT_DEVICE_POLL_WINDOW_MS = 60 * 1000;
export const TRAKT_DEVICE_SLOW_DOWN_SECONDS = 10;

type DeviceAuthSession = {
  intervalSeconds: number;
  expiresAt: number;
};

type PollState = {
  lastPollAt: number;
  intervalSeconds: number;
};

type RateBucket = {
  count: number;
  windowStart: number;
};

const deviceSessions = new Map<string, DeviceAuthSession>();
const pollStateByKey = new Map<string, PollState>();
const codeRateBuckets = new Map<string, RateBucket>();
const pollRateBuckets = new Map<string, RateBucket>();

function sessionKey(userId: number, deviceCode: string): string {
  return `${userId}:${deviceCode}`;
}

function throttleKey(req: Request, suffix: string): string {
  const userId = req.params.id ?? req.user?.id;
  return `trakt-device-${suffix}:${userId ?? req.ip}`;
}

function consumeRateLimit(
  buckets: Map<string, RateBucket>,
  key: string,
  max: number,
  windowMs: number
): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (bucket.count >= max) {
    return false;
  }
  bucket.count += 1;
  return true;
}

function createRateLimitMiddleware(options: {
  buckets: Map<string, RateBucket>;
  max: number;
  windowMs: number;
  suffix: string;
  message: string;
}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = throttleKey(req, options.suffix);
    if (
      !consumeRateLimit(options.buckets, key, options.max, options.windowMs)
    ) {
      res.status(429).json({ message: options.message });
      return;
    }
    next();
  };
}

export const traktDeviceCodeCreationLimiter = createRateLimitMiddleware({
  buckets: codeRateBuckets,
  max: TRAKT_DEVICE_CODE_MAX_PER_WINDOW,
  windowMs: TRAKT_DEVICE_CODE_WINDOW_MS,
  suffix: 'code',
  message: 'Too many Trakt device authorization attempts. Try again later.',
});

export const traktDevicePollLimiter = createRateLimitMiddleware({
  buckets: pollRateBuckets,
  max: TRAKT_DEVICE_POLL_MAX_PER_MINUTE,
  windowMs: TRAKT_DEVICE_POLL_WINDOW_MS,
  suffix: 'poll',
  message: 'Trakt device authorization polling rate limit exceeded.',
});

export function rememberTraktDeviceAuthSession(
  userId: number,
  deviceCode: string,
  intervalSeconds: number,
  expiresInSeconds: number
): void {
  const interval = Math.max(1, Math.trunc(intervalSeconds));
  deviceSessions.set(sessionKey(userId, deviceCode), {
    intervalSeconds: interval,
    expiresAt: Date.now() + Math.max(1, expiresInSeconds) * 1000,
  });
  pollStateByKey.set(sessionKey(userId, deviceCode), {
    lastPollAt: 0,
    intervalSeconds: interval,
  });
}

export function clearTraktDeviceAuthSession(
  userId: number,
  deviceCode: string
): void {
  const key = sessionKey(userId, deviceCode);
  deviceSessions.delete(key);
  pollStateByKey.delete(key);
}

export function enforceTraktDevicePollInterval(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const userId = Number(req.params.id);
  const deviceCode = String(req.body?.deviceCode ?? '').trim();
  if (!userId || !deviceCode) {
    next();
    return;
  }

  const key = sessionKey(userId, deviceCode);
  const session = deviceSessions.get(key);
  if (session && session.expiresAt <= Date.now()) {
    clearTraktDeviceAuthSession(userId, deviceCode);
    res.status(410).json({ status: 'expired' });
    return;
  }

  const pollState = pollStateByKey.get(key);
  const intervalSeconds = Math.max(
    1,
    pollState?.intervalSeconds ?? session?.intervalSeconds ?? 5
  );
  const now = Date.now();
  const elapsedMs = pollState?.lastPollAt
    ? now - pollState.lastPollAt
    : Number.POSITIVE_INFINITY;
  const requiredMs = intervalSeconds * 1000;

  if (pollState?.lastPollAt && elapsedMs < requiredMs) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((requiredMs - elapsedMs) / 1000)
    );
    res.status(429).json({
      status: 'pending',
      retryAfterSeconds,
    });
    return;
  }

  pollStateByKey.set(key, {
    lastPollAt: now,
    intervalSeconds,
  });
  next();
}

export function noteTraktDevicePollSlowDown(
  userId: number,
  deviceCode: string
): void {
  const key = sessionKey(userId, deviceCode);
  const existing = pollStateByKey.get(key);
  const nextInterval = Math.max(
    existing?.intervalSeconds ?? 5,
    TRAKT_DEVICE_SLOW_DOWN_SECONDS
  );
  pollStateByKey.set(key, {
    lastPollAt: Date.now(),
    intervalSeconds: nextInterval,
  });
}

/** Test helper */
export function resetTraktDeviceAuthThrottleState(): void {
  deviceSessions.clear();
  pollStateByKey.clear();
  codeRateBuckets.clear();
  pollRateBuckets.clear();
}
