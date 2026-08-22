import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { isDesktopRuntime } from '@server/lib/desktopState';
import fs from 'fs';
import path from 'path';

const LOGIN_STATE = ['state', 'desktop-login.json'] as const;

let cachedUserId: number | null | undefined;

const loginStatePath = (): string | undefined => {
  const configDirectory = process.env.CONFIG_DIRECTORY;
  if (!configDirectory) {
    return undefined;
  }
  return path.join(configDirectory, ...LOGIN_STATE);
};

export const resetDesktopLoginCacheForTests = (): void => {
  cachedUserId = undefined;
};

export const rememberDesktopUser = (userId: number): void => {
  if (!isDesktopRuntime() || !Number.isInteger(userId) || userId <= 0) {
    return;
  }
  if (cachedUserId === userId) {
    return;
  }
  cachedUserId = userId;
  const file = loginStatePath();
  if (!file) {
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ userId })}\n`, { mode: 0o600 });
};

export const forgetDesktopUser = (): void => {
  cachedUserId = null;
  const file = loginStatePath();
  if (!file) {
    return;
  }
  try {
    fs.unlinkSync(file);
  } catch {
    // Missing file is the logged-out state.
  }
};

export const recalledDesktopUserId = (): number | undefined => {
  if (!isDesktopRuntime()) {
    return undefined;
  }
  if (cachedUserId !== undefined) {
    return cachedUserId ?? undefined;
  }
  const file = loginStatePath();
  if (!file) {
    cachedUserId = null;
    return undefined;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      userId?: unknown;
    };
    const userId = parsed.userId;
    if (typeof userId === 'number' && Number.isInteger(userId) && userId > 0) {
      cachedUserId = userId;
      return userId;
    }
  } catch {
    // Missing or garbage — treat as logged out.
  }
  cachedUserId = null;
  return undefined;
};

/** Re-issue a session cookie on a new loopback origin after app restart. */
export const restoreDesktopSession: Middleware = async (req, _res, next) => {
  if (!isDesktopRuntime() || req.header('X-API-Key')) {
    next();
    return;
  }
  if (req.session.userId) {
    rememberDesktopUser(req.session.userId);
    next();
    return;
  }
  const recalled = recalledDesktopUserId();
  if (!recalled) {
    next();
    return;
  }
  const user = await getRepository(User).findOne({
    where: { id: recalled },
    loadEagerRelations: false,
  });
  if (!user) {
    forgetDesktopUser();
    next();
    return;
  }
  req.session.userId = user.id;
  next();
};
