import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { ServarrIntervention } from '@server/entity/ServarrIntervention';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { Permission } from '@server/lib/permissions';
import {
  publicIntervention,
  rejectServarrIntervention,
} from '@server/lib/servarrInterventions';
import { isAuthenticated } from '@server/middleware/auth';
import { Router } from 'express';
import { In } from 'typeorm';
import { ZodError, z } from 'zod';

const routes = Router();
const protectedRoute = isAuthenticated(Permission.MANAGE_REQUESTS);

const listQuery = z.object({
  mode: z.enum(['active', 'history']).default('active'),
  take: z.coerce.number().int().min(1).max(100).default(25),
  skip: z.coerce.number().int().min(0).default(0),
  serviceType: z.enum(['radarr', 'sonarr']).optional(),
  serviceId: z.coerce.number().int().positive().optional(),
  mediaType: z.nativeEnum(MediaType).optional(),
});

routes.get('/', protectedRoute, async (req, res, next) => {
  try {
    const values = listQuery.parse(req.query);
    let query = getRepository(ServarrIntervention)
      .createQueryBuilder('intervention')
      .where(
        values.mode === 'active'
          ? "intervention.state IN ('active', 'rejecting')"
          : "intervention.resolution IN ('manual_blocklist', 'automatic_blocklist')"
      );
    if (values.serviceType)
      query = query.andWhere('intervention.serviceType = :serviceType', {
        serviceType: values.serviceType,
      });
    if (values.serviceId)
      query = query.andWhere('intervention.serviceId = :serviceId', {
        serviceId: values.serviceId,
      });
    if (values.mediaType)
      query = query.andWhere('intervention.mediaType = :mediaType', {
        mediaType: values.mediaType,
      });
    const [items, count] = await query
      .orderBy(
        values.mode === 'active'
          ? 'intervention.firstSeenAt'
          : 'intervention.resolvedAt',
        'DESC'
      )
      .take(values.take)
      .skip(values.skip)
      .getManyAndCount();
    const actorIds = [
      ...new Set(
        items
          .map((item) => item.actedByUserId)
          .filter((id): id is number => id != null)
      ),
    ];
    const actors = actorIds.length
      ? await getRepository(User).find({ where: { id: In(actorIds) } })
      : [];
    const actorMap = new Map(
      actors.map((actor) => [
        actor.id,
        { id: actor.id, displayName: actor.displayName },
      ])
    );
    return res.json({
      pageInfo: {
        pages: Math.ceil(count / values.take),
        pageSize: values.take,
        results: count,
        page: Math.floor(values.skip / values.take) + 1,
      },
      results: items.map((item) => ({
        ...publicIntervention(item),
        actor: item.actedByUserId
          ? (actorMap.get(item.actedByUserId) ?? null)
          : null,
      })),
    });
  } catch (error) {
    next(
      error instanceof ZodError
        ? { status: 400, message: error.message }
        : error
    );
  }
});

routes.get('/count', protectedRoute, async (req, res, next) => {
  try {
    const repository = getRepository(ServarrIntervention);
    const active = await repository
      .createQueryBuilder('intervention')
      .where("intervention.state IN ('active', 'rejecting')")
      .getCount();
    const seenAt = req.user?.settings?.servarrInterventionsSeenAt;
    let unseenQuery = repository
      .createQueryBuilder('intervention')
      .where("intervention.state IN ('active', 'rejecting')");
    if (seenAt) {
      unseenQuery = unseenQuery.andWhere('intervention.firstSeenAt > :seenAt', {
        seenAt,
      });
    }
    return res.json({ active, unseen: await unseenQuery.getCount() });
  } catch (error) {
    next(error);
  }
});

routes.post('/seen', protectedRoute, async (req, res, next) => {
  try {
    if (!req.user) {
      return next({
        status: 403,
        message: 'You do not have permission to access this endpoint',
      });
    }
    if (!req.user.settings) {
      req.user.settings = new UserSettings({ user: req.user });
    }
    req.user.settings.servarrInterventionsSeenAt = new Date();
    await getRepository(UserSettings).save(req.user.settings);
    return res.json({ seenAt: req.user.settings.servarrInterventionsSeenAt });
  } catch (error) {
    next(error);
  }
});

routes.post('/:id/reject', protectedRoute, async (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const result = await rejectServarrIntervention(id, req.user!.id);
    return res.json(publicIntervention(result));
  } catch (error) {
    next(
      error instanceof ZodError
        ? { status: 400, message: error.message }
        : error
    );
  }
});

export default routes;
