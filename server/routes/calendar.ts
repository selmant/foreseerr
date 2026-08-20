import { getCalendarItems } from '@server/lib/calendar/service';
import { Permission } from '@server/lib/permissions';
import releaseCalendarSync from '@server/lib/releases/sync';
import { Router } from 'express';
import { parseCalendarQuery } from './calendarQuery';

const calendarRoutes = Router();
export { parseCalendarRange as parseRange } from './calendarQuery';

export { selectPrimaryRadarrDates } from '@server/lib/calendar/repository';

calendarRoutes.get('/', async (req, res, next) => {
  const isAdmin = req.user?.hasPermission(Permission.ADMIN) ?? false;
  let filters: ReturnType<typeof parseCalendarQuery>;
  try {
    filters = parseCalendarQuery(req.query, isAdmin);
  } catch (error) {
    return next({
      status: (error as { status?: number }).status ?? 400,
      message:
        error instanceof Error ? error.message : 'Invalid calendar query.',
    });
  }
  try {
    const results = await getCalendarItems(filters, {
      userId: req.user?.id,
      isAdmin,
    });

    const partialSources = releaseCalendarSync
      .getSourceStatuses()
      .filter((status) => status.lastErrorAt && !status.lastSuccessAt)
      .map((status) =>
        isAdmin
          ? { source: status.source, serverId: status.serverId }
          : { source: status.source }
      );
    return res.status(200).json({ results, partialSources });
  } catch (error) {
    return next(error);
  }
});

export default calendarRoutes;
