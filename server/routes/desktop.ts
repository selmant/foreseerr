import JellyfinAPI from '@server/api/jellyfin';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import { DesktopAuthTicket } from '@server/entity/DesktopAuthTicket';
import { Session } from '@server/entity/Session';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { isAuthenticated } from '@server/middleware/auth';
import { ApiError } from '@server/types/error';
import { getHostname } from '@server/utils/getHostname';
import { Router } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { MoreThan } from 'typeorm';
import { z } from 'zod';

const desktopRoutes = Router();
const ticketLifetimeMs = 60_000;
const maxRequestsPerWindow = 10;
const rateWindowMs = 60_000;
const requests = new Map<string, { count: number; resetAt: number }>();
const browserCacheTickets = new Map<
  string,
  { userId: number; sessionId: string; expiresAt: number }
>();

desktopRoutes.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const challengeBody = z.object({
  challenge: z.string().regex(/^[a-f0-9]{64}$/),
  protocolVersion: z.literal(1),
});

const redeemBody = z.object({
  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  verifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  protocolVersion: z.literal(1),
});

const browserCacheRedeemBody = z.object({
  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  protocolVersion: z.literal(1),
});

const digest = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const sameDigest = (left: string, right: string) => {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};

const allowRequest = (key: string) => {
  const now = Date.now();
  if (requests.size >= 4096) {
    for (const [candidate, value] of requests) {
      if (value.resetAt <= now) requests.delete(candidate);
    }
    while (requests.size >= 4096) {
      const oldest = requests.keys().next().value;
      if (!oldest) break;
      requests.delete(oldest);
    }
  }
  const current = requests.get(key);
  if (!current || current.resetAt <= now) {
    requests.set(key, { count: 1, resetAt: now + rateWindowMs });
    return true;
  }
  if (current.count >= maxRequestsPerWindow) return false;
  current.count += 1;
  return true;
};

/** Test-only: reset in-memory redeem/issue rate windows between cases. */
export const resetDesktopAuthRateLimitsForTests = () => {
  requests.clear();
  browserCacheTickets.clear();
};

const cleanupBrowserCacheTickets = () => {
  const now = Date.now();
  for (const [ticket, value] of browserCacheTickets) {
    if (value.expiresAt <= now) browserCacheTickets.delete(ticket);
  }
};

/**
 * A browser session may authorize an administrative cache action, but only the
 * native host can clear Chromium's request context. Keep the handoff opaque,
 * short-lived, single-use, and bound to the issuing session.
 */
export const issueBrowserCacheTicket = (userId: number, sessionId: string) => {
  cleanupBrowserCacheTickets();
  const ticket = randomBytes(32).toString('base64url');
  browserCacheTickets.set(digest(ticket), {
    userId,
    sessionId,
    expiresAt: Date.now() + ticketLifetimeMs,
  });
  return { ticket, expiresIn: ticketLifetimeMs };
};

const cleanupExpiredTickets = async () => {
  await getRepository(DesktopAuthTicket)
    .createQueryBuilder()
    .delete()
    .where('"expiresAt" < :now', { now: new Date() })
    .execute();
};

const externalJellyfinHost = () => {
  const settings = getSettings();
  const value = settings.jellyfin.externalHostname?.trim() || getHostname();
  const parsed = z.string().url().safeParse(value);
  if (!parsed.success || !parsed.data.startsWith('https://')) {
    throw new Error('Invalid Jellyfin desktop server URL');
  }
  const url = new URL(parsed.data);
  if (url.username || url.password) {
    throw new Error('Invalid Jellyfin desktop server URL');
  }
  return url.toString().replace(/\/$/, '');
};

const findLinkedUser = (userId: number) =>
  getRepository(User)
    .createQueryBuilder('user')
    .addSelect([
      'user.jellyfinAuthToken',
      'user.jellyfinDeviceId',
      'user.jellyfinUserId',
    ])
    .where('user.id = :userId', { userId })
    .getOne();

desktopRoutes.post(
  '/auth-tickets',
  isAuthenticated(),
  async (req, res, next) => {
    const parsed = challengeBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'invalid_request' });
    }
    if (!req.user || req.session?.userId !== req.user.id) {
      return res.status(403).json({ code: 'session_required' });
    }
    if (
      !allowRequest(`issue:ip:${req.ip}`) ||
      !allowRequest(`issue:session:${req.sessionID}`)
    ) {
      return res.status(429).json({ code: 'rate_limited' });
    }
    const settings = getSettings();
    const linkedUser = await findLinkedUser(req.user.id);
    if (
      settings.main.mediaServerType !== MediaServerType.JELLYFIN ||
      !linkedUser?.jellyfinUserId ||
      !linkedUser.jellyfinAuthToken ||
      !linkedUser.jellyfinDeviceId
    ) {
      return res.status(409).json({ code: 'not_linked' });
    }

    try {
      await cleanupExpiredTickets();
      const opaqueTicket = randomBytes(32).toString('base64url');
      const ticket = new DesktopAuthTicket({
        userId: req.user.id,
        sessionId: req.sessionID,
        ticketDigest: digest(opaqueTicket),
        challengeDigest: parsed.data.challenge,
        protocolVersion: 1,
        expiresAt: new Date(Date.now() + ticketLifetimeMs),
      });
      await getRepository(DesktopAuthTicket).save(ticket);
      return res
        .status(201)
        .json({ ticket: opaqueTicket, expiresIn: ticketLifetimeMs });
    } catch (error) {
      return next(error);
    }
  }
);

desktopRoutes.post('/auth-tickets/redeem', async (req, res, next) => {
  const parsed = redeemBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ code: 'invalid_request' });
  }
  if (!allowRequest(`redeem:ip:${req.ip ?? ''}`)) {
    return res.status(429).json({ code: 'rate_limited' });
  }
  const { ticket, verifier } = parsed.data;
  const repository = getRepository(DesktopAuthTicket);
  const record = await repository
    .createQueryBuilder('ticket')
    .addSelect('ticket.sessionId')
    .where('ticket.ticketDigest = :ticketDigest', {
      ticketDigest: digest(ticket),
    })
    .andWhere('ticket.protocolVersion = :protocolVersion', {
      protocolVersion: 1,
    })
    .getOne();
  if (!record) {
    return res.status(401).json({ code: 'ticket_expired' });
  }
  if (record.consumedAt) {
    return res.status(409).json({ code: 'ticket_used' });
  }
  if (record.expiresAt.getTime() <= Date.now()) {
    return res.status(401).json({ code: 'ticket_expired' });
  }
  if (!sameDigest(record.challengeDigest, digest(verifier))) {
    return res.status(401).json({ code: 'invalid_verifier' });
  }
  const session = await getRepository(Session).findOne({
    where: { id: record.sessionId, expiredAt: MoreThan(Date.now()) },
  });
  let sessionUserId: number | undefined;
  try {
    sessionUserId = session ? JSON.parse(session.json).userId : undefined;
  } catch {
    sessionUserId = undefined;
  }
  if (sessionUserId !== record.userId) {
    return res.status(401).json({ code: 'session_expired' });
  }

  try {
    const user = await findLinkedUser(record.userId);
    const settings = getSettings();
    if (settings.main.mediaServerType !== MediaServerType.JELLYFIN) {
      return res.status(409).json({ code: 'unsupported_media_server' });
    }
    if (
      !user?.jellyfinUserId ||
      !user.jellyfinAuthToken ||
      !user.jellyfinDeviceId
    ) {
      return res.status(409).json({ code: 'not_linked' });
    }
    const serverUrl = externalJellyfinHost();
    let linkedIdentity;
    try {
      linkedIdentity = await new JellyfinAPI(
        serverUrl,
        user.jellyfinAuthToken,
        user.jellyfinDeviceId,
        5000
      ).getUser();
    } catch (error) {
      const status = error instanceof ApiError ? error.statusCode : undefined;
      const code =
        status === 401 || status === 403
          ? 'token_invalid'
          : 'server_unreachable';
      return res.status(code === 'token_invalid' ? 401 : 503).json({ code });
    }
    if (linkedIdentity.Id !== user.jellyfinUserId || !linkedIdentity.ServerId) {
      return res.status(401).json({ code: 'token_invalid' });
    }

    // Consume only after Jellyfin bootstrap succeeds so a transient failure
    // can retry the same ticket within its TTL.
    const result = await repository
      .createQueryBuilder()
      .update(DesktopAuthTicket)
      .set({ consumedAt: new Date() })
      .where('id = :id AND "consumedAt" IS NULL AND "expiresAt" > :now', {
        id: record.id,
        now: new Date(),
      })
      .execute();
    if (result.affected !== 1) {
      return res.status(409).json({ code: 'ticket_used' });
    }

    return res.status(200).json({
      serverUrl,
      serverId: linkedIdentity.ServerId,
      userId: user.jellyfinUserId,
      deviceId: user.jellyfinDeviceId,
      accessToken: user.jellyfinAuthToken,
      bootstrapGeneration: randomBytes(12).toString('hex'),
    });
  } catch (error) {
    return next(error);
  }
});

desktopRoutes.post('/browser-cache/redeem', async (req, res, next) => {
  const parsed = browserCacheRedeemBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ code: 'invalid_request' });
  }
  if (!allowRequest(`browser-cache:ip:${req.ip ?? ''}`)) {
    return res.status(429).json({ code: 'rate_limited' });
  }

  cleanupBrowserCacheTickets();
  const ticketDigest = digest(parsed.data.ticket);
  const record = browserCacheTickets.get(ticketDigest);
  // Consume before I/O to make the action unrepeatable even if a client races
  // the native bridge. The action itself is idempotent.
  browserCacheTickets.delete(ticketDigest);
  if (!record || record.expiresAt <= Date.now()) {
    return res.status(401).json({ code: 'ticket_expired' });
  }

  try {
    const session = await getRepository(Session).findOne({
      where: { id: record.sessionId, expiredAt: MoreThan(Date.now()) },
    });
    let sessionUserId: number | undefined;
    try {
      sessionUserId = session ? JSON.parse(session.json).userId : undefined;
    } catch {
      sessionUserId = undefined;
    }
    const user = await getRepository(User).findOne({
      where: { id: record.userId },
    });
    if (
      sessionUserId !== record.userId ||
      !user?.hasPermission(Permission.ADMIN)
    ) {
      return res.status(401).json({ code: 'session_expired' });
    }
    return res.status(204).send();
  } catch (error) {
    return next(error);
  }
});

export default desktopRoutes;
