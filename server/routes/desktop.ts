import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import { DesktopAuthTicket } from '@server/entity/DesktopAuthTicket';
import { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import { isAuthenticated } from '@server/middleware/auth';
import { getHostname } from '@server/utils/getHostname';
import { Router } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const desktopRoutes = Router();
const ticketLifetimeMs = 60_000;
const maxRequestsPerWindow = 10;
const rateWindowMs = 60_000;
const requests = new Map<string, { count: number; resetAt: number }>();

const challengeBody = z.object({
  challenge: z.string().regex(/^[a-f0-9]{64}$/),
  protocolVersion: z.literal(1),
});

const redeemBody = z.object({
  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  verifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
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
  const current = requests.get(key);
  if (!current || current.resetAt <= now) {
    requests.set(key, { count: 1, resetAt: now + rateWindowMs });
    return true;
  }
  if (current.count >= maxRequestsPerWindow) return false;
  current.count += 1;
  return true;
};

const cleanupExpiredTickets = async () => {
  await getRepository(DesktopAuthTicket)
    .createQueryBuilder()
    .delete()
    .where('expiresAt < :now', { now: new Date() })
    .execute();
};

const externalJellyfinHost = () => {
  const settings = getSettings();
  return settings.jellyfin.externalHostname?.trim() || getHostname();
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
    if (!parsed.success || !req.user) {
      return res.status(400).json({ code: 'invalid_request' });
    }
    const key = `${req.ip}:${req.user.id}`;
    if (!allowRequest(key)) {
      return res.status(429).json({ code: 'rate_limited' });
    }
    const settings = getSettings();
    const linkedUser = await findLinkedUser(req.user.id);
    if (
      settings.main.mediaServerType !== MediaServerType.JELLYFIN ||
      !linkedUser?.jellyfinUserId ||
      !linkedUser.jellyfinAuthToken ||
      !linkedUser.jellyfinDeviceId ||
      !settings.jellyfin.serverId
    ) {
      return res.status(409).json({ code: 'not_linked' });
    }

    try {
      await cleanupExpiredTickets();
      const opaqueTicket = randomBytes(32).toString('base64url');
      const ticket = new DesktopAuthTicket({
        userId: req.user.id,
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
  if (!allowRequest(req.ip ?? '')) {
    return res.status(429).json({ code: 'rate_limited' });
  }
  const { ticket, verifier } = parsed.data;
  const repository = getRepository(DesktopAuthTicket);
  const record = await repository.findOne({
    where: { ticketDigest: digest(ticket), protocolVersion: 1 },
  });
  if (!record || record.consumedAt) {
    return res
      .status(401)
      .json({ code: record ? 'ticket_used' : 'ticket_expired' });
  }
  if (record.expiresAt.getTime() <= Date.now()) {
    return res.status(401).json({ code: 'ticket_expired' });
  }
  if (!sameDigest(record.challengeDigest, digest(verifier))) {
    return res.status(401).json({ code: 'invalid_verifier' });
  }

  // Consume atomically so two native workers cannot redeem the same ticket.
  const result = await repository
    .createQueryBuilder()
    .update(DesktopAuthTicket)
    .set({ consumedAt: new Date() })
    .where('id = :id AND consumedAt IS NULL AND expiresAt > :now', {
      id: record.id,
      now: new Date(),
    })
    .execute();
  if (result.affected !== 1) {
    return res.status(409).json({ code: 'ticket_used' });
  }

  try {
    const user = await findLinkedUser(record.userId);
    const settings = getSettings();
    if (
      !user?.jellyfinUserId ||
      !user.jellyfinAuthToken ||
      !user.jellyfinDeviceId ||
      settings.main.mediaServerType !== MediaServerType.JELLYFIN
    ) {
      return res.status(409).json({ code: 'not_linked' });
    }
    return res.status(200).json({
      serverUrl: externalJellyfinHost(),
      serverId: settings.jellyfin.serverId,
      userId: user.jellyfinUserId,
      deviceId: user.jellyfinDeviceId,
      accessToken: user.jellyfinAuthToken,
      bootstrapGeneration: randomBytes(12).toString('hex'),
    });
  } catch (error) {
    return next(error);
  }
});

export default desktopRoutes;
