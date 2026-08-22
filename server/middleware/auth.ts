import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import type {
  Permission,
  PermissionCheckOptions,
} from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';

const loadUserById = async (userId: number): Promise<User | null> => {
  return getRepository(User).findOne({
    where: { id: userId },
    // Never join settings here. User.settings is eager and UserSettings.user
    // points back; loading that graph on every API request wedges Node
    // (desktop login looks like a silent Sign In bounce).
    loadEagerRelations: false,
  });
};

const localeForUser = async (
  userId: number,
  fallback: string
): Promise<string> => {
  const row = await getRepository(UserSettings)
    .createQueryBuilder('us')
    .select('us.locale', 'locale')
    .where('us.userId = :userId', { userId })
    .getRawOne<{ locale?: string | null }>();
  return row?.locale || fallback;
};

export const checkUser: Middleware = async (req, _res, next) => {
  const settings = getSettings();
  let user: User | undefined | null;

  if (req.header('X-API-Key') === settings.main.apiKey) {
    let userId = 1; // Work on original administrator account

    // If a User ID is provided, we will act on that user's behalf
    if (req.header('X-API-User')) {
      userId = Number(req.header('X-API-User'));
    }

    user = await loadUserById(userId);
  } else if (req.session?.userId) {
    user = await loadUserById(req.session.userId);
  }

  if (user) {
    req.user = user;
    req.locale = await localeForUser(user.id, settings.main.locale);
  } else {
    req.locale = settings.main.locale;
  }

  next();
};

export const isAuthenticated = (
  permissions?: Permission | Permission[],
  options?: PermissionCheckOptions
): Middleware => {
  const authMiddleware: Middleware = (req, res, next) => {
    if (!req.user || !req.user.hasPermission(permissions ?? 0, options)) {
      res.status(403).json({
        status: 403,
        error: 'You do not have permission to access this endpoint',
      });
    } else {
      next();
    }
  };
  return authMiddleware;
};
