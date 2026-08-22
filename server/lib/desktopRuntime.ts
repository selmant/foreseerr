import fs from 'fs/promises';
import path from 'path';

export const DESKTOP_LOCK_EXIT_CODE = 73;
export const DESKTOP_SCHEMA_EXIT_CODE = 74;

export interface DesktopRuntimeError extends Error {
  exitCode?: number;
}

export const desktopError = (
  message: string,
  exitCode: number
): DesktopRuntimeError => {
  const error = new Error(message) as DesktopRuntimeError;
  error.exitCode = exitCode;
  return error;
};

export const acquireDesktopLock = async (): Promise<() => Promise<void>> => {
  const configDirectory = process.env.CONFIG_DIRECTORY;
  if (!configDirectory) {
    throw desktopError(
      'Desktop runtime requires CONFIG_DIRECTORY',
      DESKTOP_LOCK_EXIT_CODE
    );
  }
  const lockPath = path.join(configDirectory, 'state', 'instance.lock');
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number.parseInt(
      (await fs.readFile(lockPath, 'utf8').catch(() => '')).trim(),
      10
    );
    let alive = Number.isInteger(pid) && pid > 0;
    if (alive) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
    }
    if (alive) {
      throw desktopError(
        'Another Foreseer Desktop instance owns this data directory',
        DESKTOP_LOCK_EXIT_CODE
      );
    }
    await fs.unlink(lockPath).catch(() => undefined);
    try {
      handle = await fs.open(lockPath, 'wx', 0o600);
    } catch {
      throw desktopError(
        'Another Foreseer Desktop instance owns this data directory',
        DESKTOP_LOCK_EXIT_CODE
      );
    }
  }
  await handle.writeFile(`${process.pid}\n`);
  return async () => {
    await handle.close().catch(() => undefined);
    await fs.unlink(lockPath).catch(() => undefined);
  };
};
